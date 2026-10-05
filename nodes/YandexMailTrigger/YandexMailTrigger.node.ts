import type {
	IDataObject,
	ILoadOptionsFunctions,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	IPollFunctions,
	INodeExecutionData,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { DEFAULT_ALERT_AFTER, DEFAULT_MAX_PER_POLL, MAX_BACKOFF_MS, SLOW_GREETING_MS } from '../shared/constants';
import { formatYandexError, isAuthError, isTransientImapError } from '../shared/errors';
import { DEFAULT_ATTACHMENT_PREFIX, envelopeToItem } from '../shared/binary';
import { messagePassesFilters } from '../shared/parse';
import {
	fetchMessagesByUid,
	getMailboxMeta,
	listFolders,
	readCredentials,
	resolvePollFolders,
	searchNewUids,
	withYandexClient,
	yandexMailConnectionTest,
} from '../shared/transport';
import { parseExcludeSenders, resolveCursor, type FolderCursor, type TriggerStaticData } from '../shared/watermark';

export class YandexMailTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Yandex Mail Trigger',
		name: 'yandexMailTrigger',
		icon: 'file:yandex-mail.svg',
		group: ['trigger'],
		version: 1,
		description: 'Polls Yandex Mail over short IMAP sessions and starts the workflow on new messages',
		eventTriggerDescription: 'Waiting for a new Yandex Mail message',
		subtitle: 'Yandex Mail',
		defaults: {
			name: 'Yandex Mail Trigger',
		},
		polling: true,
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'yandexMailApi',
				required: true,
				testedBy: 'yandexMailConnectionTest',
			},
		],
		properties: [
			{
				displayName: 'Folder Names or IDs',
				name: 'mailboxes',
				type: 'multiOptions',
				typeOptions: {
					loadOptionsMethod: 'getMailboxes',
				},
				default: ['INBOX'],
				description:
					'Folders to poll in one IMAP connection. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Include Junk Folder',
				name: 'includeJunk',
				type: 'boolean',
				default: true,
				description:
					'Whether to also poll the Yandex Junk/Spam folder in the same short session',
			},
			{
				displayName: 'Fetch Only New Emails',
				name: 'fetchOnlyNew',
				type: 'boolean',
				default: true,
				description:
					'Whether to skip mail already in the folder when the trigger first starts or UIDVALIDITY changes',
			},
			{
				displayName: 'Max Emails per Poll',
				name: 'maxPerPoll',
				type: 'number',
				default: DEFAULT_MAX_PER_POLL,
				typeOptions: {
					minValue: 1,
					maxValue: 50,
				},
				description:
					'Maximum number of emails to fetch each time the node polls for new messages. If more emails arrive between polls, the remaining ones will be picked up in subsequent polls.',
			},
			{
				displayName: 'Download Attachments',
				name: 'downloadAttachments',
				type: 'boolean',
				default: true,
				description:
					'Whether to put file bytes on $binary.attachment_0, attachment_1, … so Extract From File and IF $binary.attachment_0 work like Email Read IMAP',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Advance Cursor on Manual Run',
						name: 'advanceCursorOnManual',
						type: 'boolean',
						default: false,
						description:
							'Whether executing the step in the editor should move the UID cursor. Left off, a manual run only previews mail.',
					},
					{
						displayName: 'Alert After Failures',
						name: 'alertAfterFailures',
						type: 'number',
						default: DEFAULT_ALERT_AFTER,
						typeOptions: {
							minValue: 1,
						},
						description:
							'How many consecutive failed polls are allowed before one error is logged and the optional webhook is called',
					},
					{
						displayName: 'Alert Webhook URL',
						name: 'alertWebhookUrl',
						type: 'string',
						default: '',
						placeholder: 'https://example.com/yandex-mail-silence',
						description:
							'Optional URL that receives one POST after the failure threshold. Used as a silence watchdog.',
					},
					{
						displayName: 'Attachments Prefix',
						name: 'attachmentsPrefix',
						type: 'string',
						default: DEFAULT_ATTACHMENT_PREFIX,
						description:
							'Prefix for $binary keys. With the default, the first file is attachment_0.',
					},
					{
						displayName: 'Exclude Senders',
						name: 'excludeSenders',
						type: 'string',
						default: '',
						placeholder: 'alerts@example.com, noreply@example.com',
						description: 'Comma-separated addresses to drop before the workflow starts',
					},
					{
						displayName: 'Ignore Subject Regex',
						name: 'subjectIgnoreRegex',
						type: 'string',
						default: '',
						placeholder: '^noreply',
						description: 'Drop messages whose subject matches this regular expression',
					},
					{
						displayName: 'Include Inline Attachments',
						name: 'includeInlineAttachments',
						type: 'boolean',
						default: false,
						description:
							'Whether to also put CID/inline images on $binary. Left off so a CSV stays attachment_0.',
					},
					{
						displayName: 'Mark as Read',
						name: 'markSeen',
						type: 'boolean',
						default: false,
						description:
							'Whether to set the Seen flag after a successful fetch. Leave off if a later node moves the message.',
					},
					{
						displayName: 'Max Size (KB)',
						name: 'maxSizeKb',
						type: 'number',
						default: 0,
						typeOptions: {
							minValue: 0,
						},
						description: 'Skip messages larger than this size in kilobytes. 0 disables the limit.',
					},
					{
						displayName: 'Reset Watermark',
						name: 'resetWatermark',
						type: 'boolean',
						default: false,
						description:
							'Whether to forget stored UIDs on the next poll and apply Fetch Only New Emails again',
					},
				],
			},
		],
	};

	methods = {
		credentialTest: {
			yandexMailConnectionTest,
		},
		loadOptions: {
			async getMailboxes(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const creds = readCredentials(await this.getCredentials('yandexMailApi'));
				return await withYandexClient(creds, async (client) => {
					const folders = await listFolders(client);
					return folders.map((folder) => ({
						name: folder.isJunk
							? `${folder.path} (Spam)`
							: folder.isInbox
								? `${folder.path} (Inbox)`
								: folder.isTrash
									? `${folder.path} (Trash)`
									: folder.isSent
										? `${folder.path} (Sent)`
										: folder.path,
						value: folder.path,
					}));
				});
			},
		},
	};

	async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
		const staticData = this.getWorkflowStaticData('node') as TriggerStaticData;
		const now = Date.now();
		if (staticData.nextPollAfter && now < staticData.nextPollAfter) {
			// n8n already spaces polls. A multi-minute skip here blocks activate/kick
			// after a transient IMAP drop (Connection not available).
			const remaining = staticData.nextPollAfter - now;
			if (remaining > 15_000) {
				delete staticData.nextPollAfter;
			} else {
				return null;
			}
		}

		const options = this.getNodeParameter('options', {}) as IDataObject;
		const fetchOnlyNew = this.getNodeParameter('fetchOnlyNew') as boolean;
		const includeJunk = this.getNodeParameter('includeJunk') as boolean;
		const maxPerPoll = this.getNodeParameter('maxPerPoll') as number;
		const selected = this.getNodeParameter('mailboxes') as string[];
		const downloadAttachments = this.getNodeParameter('downloadAttachments', true) as boolean;
		const attachmentsPrefix = String(options.attachmentsPrefix || DEFAULT_ATTACHMENT_PREFIX);
		const includeInlineAttachments = Boolean(options.includeInlineAttachments);
		const markSeen = Boolean(options.markSeen);
		const advanceCursorOnManual = Boolean(options.advanceCursorOnManual);
		const resetWatermark = Boolean(options.resetWatermark);
		const alertAfterFailures = Number(options.alertAfterFailures || DEFAULT_ALERT_AFTER);
		const alertWebhookUrl = String(options.alertWebhookUrl || '');
		const filters = {
			excludeSenders: parseExcludeSenders(String(options.excludeSenders || '')),
			subjectIgnoreRegex: String(options.subjectIgnoreRegex || ''),
			maxSizeKb: Number(options.maxSizeKb || 0),
		};

		const manual = this.getMode() === 'manual';
		const persistCursor = !manual || advanceCursorOnManual;

		if (resetWatermark) {
			staticData.folders = {};
		}

		const creds = readCredentials(await this.getCredentials('yandexMailApi'));

		try {
			const collected: INodeExecutionData[] = [];
			await withYandexClient(creds, async (client, greetingMs) => {
				staticData.lastGreetingMs = greetingMs;
				if (greetingMs >= SLOW_GREETING_MS) {
					staticData.nextPollAfter = Date.now() + Math.min(MAX_BACKOFF_MS, greetingMs * 20);
				} else {
					delete staticData.nextPollAfter;
				}

				const folders = await listFolders(client);
				const mailboxPaths = resolvePollFolders(folders, selected, includeJunk);
				const remaining = manual ? 1 : maxPerPoll;
				let budget = remaining;
				const cursors = staticData.folders ?? {};

				for (const mailbox of mailboxPaths) {
					if (budget <= 0) {
						break;
					}
					const probe = await getMailboxMeta(client, mailbox);
					const previous = cursors[mailbox] as FolderCursor | undefined;
					const decision = resolveCursor(probe.uidValidity, probe.uidNext, previous, fetchOnlyNew);
					if (decision.validityChanged) {
						this.logger.warn(
							`Yandex Mail UIDVALIDITY changed for ${mailbox}, cursor reset (fetchOnlyNew=${fetchOnlyNew})`,
						);
					}
					if (decision.skipFetch) {
						if (persistCursor) {
							cursors[mailbox] = decision.nextIfEmpty;
						}
						continue;
					}
					const found = await searchNewUids(client, mailbox, decision.fromUid, budget);
					const messages = await fetchMessagesByUid(client, mailbox, found.uids, markSeen);
					let maxUid = persistCursor ? decision.nextIfEmpty.lastUid : previous?.lastUid ?? 0;
					for (const envelope of messages) {
						const message = envelope.message;
						if (message.uid < decision.fromUid) {
							continue;
						}
						if (!messagePassesFilters(message, filters)) {
							if (persistCursor && message.uid > maxUid) {
								maxUid = message.uid;
							}
							continue;
						}
						collected.push(
							await envelopeToItem(this.helpers, envelope, {
								downloadAttachments,
								includeInline: includeInlineAttachments,
								prefix: attachmentsPrefix,
							}),
						);
						if (persistCursor && message.uid > maxUid) {
							maxUid = message.uid;
						}
						budget -= 1;
					}
					if (persistCursor) {
						cursors[mailbox] = { uidValidity: found.uidValidity, lastUid: maxUid };
					}
				}
				staticData.folders = cursors;
			});

			staticData.lastSuccessAt = new Date().toISOString();
			staticData.consecutiveFailures = 0;
			staticData.lastError = '';
			staticData.alertSent = false;

			return collected.length ? [collected] : null;
		} catch (err) {
			if (manual || isAuthError(err)) {
				throw new NodeOperationError(this.getNode(), formatYandexError(err));
			}

			staticData.consecutiveFailures = (staticData.consecutiveFailures ?? 0) + 1;
			staticData.lastError = formatYandexError(err);
			const failures = staticData.consecutiveFailures;
			const backoff = Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** Math.min(failures, 6));
			staticData.nextPollAfter = Date.now() + backoff;

			if (isTransientImapError(err) && failures < alertAfterFailures) {
				this.logger.warn(
					`Yandex Mail poll recovered path: ${staticData.lastError} (failure ${failures}/${alertAfterFailures})`,
				);
				return null;
			}

			this.logger.error(`Yandex Mail poll failed ${failures} time(s): ${staticData.lastError}`);
			if (alertWebhookUrl && !staticData.alertSent) {
				try {
					await this.helpers.httpRequest({
						method: 'POST',
						url: alertWebhookUrl,
						body: {
							source: 'n8n-nodes-yandex-mail',
							workflowId: this.getWorkflow().id,
							nodeName: this.getNode().name,
							consecutiveFailures: failures,
							lastError: staticData.lastError,
							lastSuccessAt: staticData.lastSuccessAt ?? '',
						},
						headers: { 'content-type': 'application/json' },
					});
					staticData.alertSent = true;
				} catch (hookErr) {
					this.logger.warn(`Yandex Mail silence webhook failed: ${formatYandexError(hookErr)}`);
				}
			}

			if (failures >= alertAfterFailures) {
				throw new NodeOperationError(this.getNode(), staticData.lastError || formatYandexError(err));
			}
			return null;
		}
	}
}
