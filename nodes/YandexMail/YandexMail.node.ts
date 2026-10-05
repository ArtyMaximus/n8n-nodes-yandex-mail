import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import {
	appendMessage,
	copyMessage,
	createFolder,
	deleteFolder,
	deleteMessage,
	diagnoseMailbox,
	fetchMessagesByUid,
	getFolderStatus,
	listFolders,
	locateMessage,
	markMessage,
	moveMessage,
	readCredentials,
	searchNewUids,
	withYandexClient,
	yandexMailConnectionTest,
	type YandexFlagAction,
} from '../shared/transport';
import { sendMessage } from '../shared/send';

export class YandexMail implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Yandex Mail',
		name: 'yandexMail',
		icon: 'file:yandex-mail.svg',
		group: ['input'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'List folders, fetch, send, move, copy, mark, and delete Yandex Mail over short IMAP/SMTP sessions',
		defaults: {
			name: 'Yandex Mail',
		},
		inputs: [NodeConnectionTypes.Main],
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
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Mailbox',
						value: 'mailbox',
					},
					{
						name: 'Message',
						value: 'message',
					},
				],
				default: 'mailbox',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['mailbox'],
					},
				},
				options: [
					{
						name: 'Create Folder',
						value: 'createFolder',
						action: 'Create a folder',
						description: 'Create an IMAP folder. Yandex uses | as the hierarchy delimiter.',
					},
					{
						name: 'Delete Folder',
						value: 'deleteFolder',
						action: 'Delete an empty folder',
						description: 'Delete an empty custom folder. System folders are refused.',
					},
					{
						name: 'Diagnose',
						value: 'diagnose',
						action: 'Diagnose mailbox connection',
						description: 'Return CAPABILITY, folders, greeting time, and UIDNEXT',
					},
					{
						name: 'Get Status',
						value: 'getStatus',
						action: 'Get mailbox status',
						description: 'Return MESSAGES, UNSEEN, UIDNEXT, and UIDVALIDITY',
					},
					{
						name: 'List',
						value: 'list',
						action: 'List folders',
						description: 'List folders with XLIST special-use flags',
					},
				],
				default: 'list',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['message'],
					},
				},
				options: [
					{
						name: 'Append',
						value: 'append',
						action: 'Append a message to a folder',
						description: 'Create a local message in a folder without SMTP. Use this for isolated tests.',
					},
					{
						name: 'Copy',
						value: 'copy',
						action: 'Copy a message',
						description: 'Copy one message and return the new UID in the destination folder',
					},
					{
						name: 'Delete',
						value: 'delete',
						action: 'Delete a message',
						description: 'Move to Trash, or permanently expunge',
					},
					{
						name: 'Get',
						value: 'get',
						action: 'Get a message',
						description: 'Fetch one message by UID or Message-ID',
					},
					{
						name: 'Get Many',
						value: 'getAll',
						action: 'Get many messages',
						description: 'Fetch messages with UID greater than or equal to a value',
					},
					{
						name: 'Mark',
						value: 'mark',
						action: 'Mark a message',
						description: 'Set or clear Seen / Flagged',
					},
					{
						name: 'Move',
						value: 'move',
						action: 'Move a message',
						description:
							'Move one message and return the new UID. A later move uses that UID, or Message-ID if the old UID is gone.',
					},
					{
						name: 'Send',
						value: 'send',
						action: 'Send a message',
						description: 'Send mail through Yandex SMTP with the same app password',
					},
				],
				default: 'get',
			},
			{
				displayName: 'Folder Name or ID',
				name: 'mailbox',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getMailboxes',
				},
				default: 'INBOX',
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				displayOptions: {
					show: {
						resource: ['mailbox'],
						operation: ['getStatus', 'deleteFolder'],
					},
				},
			},
			{
				displayName: 'Folder Path',
				name: 'folderPath',
				type: 'string',
				default: '',
				placeholder: 'n8n-node-tests|sub',
				required: true,
				description: 'IMAP path. Nested folders use | on Yandex, for example n8n-node-tests|sub.',
				displayOptions: {
					show: {
						resource: ['mailbox'],
						operation: ['createFolder'],
					},
				},
			},
			{
				displayName: 'Folder Name or ID',
				name: 'mailbox',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getMailboxes',
				},
				default: 'INBOX',
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				displayOptions: {
					show: {
						resource: ['message'],
						operation: ['get', 'getAll', 'move', 'copy', 'mark', 'delete', 'append'],
					},
				},
			},
			{
				displayName: 'UID',
				name: 'uid',
				type: 'number',
				default: 0,
				typeOptions: {
					minValue: 0,
				},
				description:
					'IMAP UID in this folder. After Move/Copy, use the new uid from that node. 0 skips UID and uses Message ID.',
				displayOptions: {
					show: {
						resource: ['message'],
						operation: ['get', 'move', 'copy', 'mark', 'delete'],
					},
				},
			},
			{
				displayName: 'Message ID',
				name: 'messageId',
				type: 'string',
				default: '',
				placeholder: '{{ $json.messageId }}',
				description:
					'RFC Message-ID from the trigger. Finds the letter after a move when the old UID is gone.',
				displayOptions: {
					show: {
						resource: ['message'],
						operation: ['get', 'move', 'copy', 'mark', 'delete'],
					},
				},
			},
			{
				displayName: 'Destination Folder Name or ID',
				name: 'destination',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getMailboxes',
				},
				default: '',
				required: true,
				description:
					'Target folder. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				displayOptions: {
					show: {
						resource: ['message'],
						operation: ['move', 'copy'],
					},
				},
			},
			{
				displayName: 'Mark As',
				name: 'markAs',
				type: 'options',
				options: [
					{ name: 'Read', value: 'seen' },
					{ name: 'Unread', value: 'unseen' },
					{ name: 'Flagged', value: 'flagged' },
					{ name: 'Unflagged', value: 'unflagged' },
				],
				default: 'seen',
				displayOptions: {
					show: {
						resource: ['message'],
						operation: ['mark'],
					},
				},
			},
			{
				displayName: 'Delete Mode',
				name: 'deleteMode',
				type: 'options',
				options: [
					{
						name: 'Move to Trash',
						value: 'trash',
						description: 'MOVE to the XLIST Trash folder and return the new UID',
					},
					{
						name: 'Permanent',
						value: 'permanent',
						description: 'Expunge the message. Cannot undo.',
					},
				],
				default: 'trash',
				displayOptions: {
					show: {
						resource: ['message'],
						operation: ['delete'],
					},
				},
			},
			{
				displayName: 'From UID',
				name: 'fromUid',
				type: 'number',
				default: 1,
				typeOptions: {
					minValue: 1,
				},
				description: 'Lowest IMAP UID to include',
				displayOptions: {
					show: {
						resource: ['message'],
						operation: ['getAll'],
					},
				},
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				default: 50,
				typeOptions: {
					minValue: 1,
				},
				description: 'Max number of results to return',
				displayOptions: {
					show: {
						resource: ['message'],
						operation: ['getAll'],
					},
				},
			},
			{
				displayName: 'To',
				name: 'to',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'name@example.com',
				description: 'Recipient address. Send to this mailbox to test the trigger.',
				displayOptions: {
					show: {
						resource: ['message'],
						operation: ['send'],
					},
				},
			},
			{
				displayName: 'Subject',
				name: 'subject',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						resource: ['message'],
						operation: ['send', 'append'],
					},
				},
			},
			{
				displayName: 'Text',
				name: 'text',
				type: 'string',
				typeOptions: {
					rows: 5,
				},
				default: '',
				displayOptions: {
					show: {
						resource: ['message'],
						operation: ['send', 'append'],
					},
				},
			},
			{
				displayName: 'HTML',
				name: 'html',
				type: 'string',
				typeOptions: {
					rows: 5,
				},
				default: '',
				description: 'Optional HTML body. Text is still sent as the plain part.',
				displayOptions: {
					show: {
						resource: ['message'],
						operation: ['send'],
					},
				},
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

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const creds = readCredentials(await this.getCredentials('yandexMailApi'));
		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		try {
			if (resource === 'mailbox' && operation === 'diagnose') {
				const report = await diagnoseMailbox(creds);
				returnData.push({ json: report as IDataObject });
				return [returnData];
			}

			if (resource === 'message' && operation === 'send') {
				for (let i = 0; i < items.length; i++) {
					const sent = await sendMessage(creds, {
						to: this.getNodeParameter('to', i) as string,
						subject: this.getNodeParameter('subject', i) as string,
						text: this.getNodeParameter('text', i) as string,
						html: this.getNodeParameter('html', i, '') as string,
					});
					returnData.push({ json: sent as unknown as IDataObject });
				}
				return [returnData];
			}

			await withYandexClient(creds, async (client) => {
				if (resource === 'mailbox' && operation === 'list') {
					const folders = await listFolders(client);
					for (const folder of folders) {
						returnData.push({ json: folder as unknown as IDataObject });
					}
					return;
				}

				if (resource === 'mailbox' && operation === 'getStatus') {
					for (let i = 0; i < items.length; i++) {
						const mailbox = this.getNodeParameter('mailbox', i) as string;
						const status = await getFolderStatus(client, mailbox);
						returnData.push({ json: status as unknown as IDataObject });
					}
					return;
				}

				if (resource === 'mailbox' && operation === 'createFolder') {
					for (let i = 0; i < items.length; i++) {
						const folderPath = this.getNodeParameter('folderPath', i) as string;
						const created = await createFolder(client, folderPath);
						returnData.push({ json: created as unknown as IDataObject });
					}
					return;
				}

				if (resource === 'mailbox' && operation === 'deleteFolder') {
					for (let i = 0; i < items.length; i++) {
						const mailbox = this.getNodeParameter('mailbox', i) as string;
						const deleted = await deleteFolder(client, mailbox);
						returnData.push({ json: deleted as unknown as IDataObject });
					}
					return;
				}

				if (resource === 'message' && operation === 'append') {
					for (let i = 0; i < items.length; i++) {
						const mailbox = this.getNodeParameter('mailbox', i) as string;
						const appended = await appendMessage(client, mailbox, {
							subject: this.getNodeParameter('subject', i) as string,
							text: this.getNodeParameter('text', i) as string,
							from: creds.user,
						});
						returnData.push({ json: appended as unknown as IDataObject });
					}
					return;
				}

				if (resource === 'message' && operation === 'get') {
					for (let i = 0; i < items.length; i++) {
						const mailbox = this.getNodeParameter('mailbox', i) as string;
						const uid = Number(this.getNodeParameter('uid', i, 0) || 0);
						const messageId = String(this.getNodeParameter('messageId', i, '') || '');
						assertLocator(this, uid, messageId, i);
						const located = await locateMessage(client, mailbox, uid, messageId);
						const messages = await fetchMessagesByUid(client, located.mailbox, [located.uid], false);
						if (!messages.length) {
							throw new NodeOperationError(
								this.getNode(),
								`Message UID ${located.uid} was not found in ${located.mailbox}`,
								{ itemIndex: i },
							);
						}
						returnData.push({ json: messages[0] as unknown as IDataObject });
					}
					return;
				}

				if (resource === 'message' && operation === 'getAll') {
					const mailbox = this.getNodeParameter('mailbox', 0) as string;
					const fromUid = this.getNodeParameter('fromUid', 0) as number;
					const limit = this.getNodeParameter('limit', 0) as number;
					const found = await searchNewUids(client, mailbox, fromUid, limit);
					const messages = await fetchMessagesByUid(client, mailbox, found.uids, false);
					for (const message of messages) {
						returnData.push({ json: message as unknown as IDataObject });
					}
					return;
				}

				if (resource === 'message' && operation === 'move') {
					for (let i = 0; i < items.length; i++) {
						const mailbox = this.getNodeParameter('mailbox', i) as string;
						const destination = this.getNodeParameter('destination', i) as string;
						const uid = Number(this.getNodeParameter('uid', i, 0) || 0);
						const messageId = String(this.getNodeParameter('messageId', i, '') || '');
						assertLocator(this, uid, messageId, i);
						const moved = await moveMessage(client, mailbox, destination, uid, messageId);
						returnData.push({ json: moved as unknown as IDataObject });
					}
					return;
				}

				if (resource === 'message' && operation === 'copy') {
					for (let i = 0; i < items.length; i++) {
						const mailbox = this.getNodeParameter('mailbox', i) as string;
						const destination = this.getNodeParameter('destination', i) as string;
						const uid = Number(this.getNodeParameter('uid', i, 0) || 0);
						const messageId = String(this.getNodeParameter('messageId', i, '') || '');
						assertLocator(this, uid, messageId, i);
						const copied = await copyMessage(client, mailbox, destination, uid, messageId);
						returnData.push({ json: copied as unknown as IDataObject });
					}
					return;
				}

				if (resource === 'message' && operation === 'mark') {
					for (let i = 0; i < items.length; i++) {
						const mailbox = this.getNodeParameter('mailbox', i) as string;
						const uid = Number(this.getNodeParameter('uid', i, 0) || 0);
						const messageId = String(this.getNodeParameter('messageId', i, '') || '');
						const markAs = this.getNodeParameter('markAs', i) as YandexFlagAction;
						assertLocator(this, uid, messageId, i);
						const marked = await markMessage(client, mailbox, uid, messageId, markAs);
						returnData.push({ json: marked as unknown as IDataObject });
					}
					return;
				}

				if (resource === 'message' && operation === 'delete') {
					for (let i = 0; i < items.length; i++) {
						const mailbox = this.getNodeParameter('mailbox', i) as string;
						const uid = Number(this.getNodeParameter('uid', i, 0) || 0);
						const messageId = String(this.getNodeParameter('messageId', i, '') || '');
						const deleteMode = this.getNodeParameter('deleteMode', i) as 'trash' | 'permanent';
						assertLocator(this, uid, messageId, i);
						const deleted = await deleteMessage(client, mailbox, uid, messageId, deleteMode);
						returnData.push({ json: deleted as unknown as IDataObject });
					}
				}
			});
		} catch (err) {
			if (this.continueOnFail()) {
				returnData.push({
					json: { error: err instanceof Error ? err.message : String(err) },
				});
				return [returnData];
			}
			throw new NodeOperationError(this.getNode(), err instanceof Error ? err : new Error(String(err)));
		}

		return [returnData];
	}
}

function assertLocator(ctx: IExecuteFunctions, uid: number, messageId: string, itemIndex: number) {
	if (uid < 1 && !messageId.trim()) {
		throw new NodeOperationError(
			ctx.getNode(),
			'Need a UID or a Message ID. Pass both from the trigger so a later action still finds the letter.',
			{ itemIndex },
		);
	}
}
