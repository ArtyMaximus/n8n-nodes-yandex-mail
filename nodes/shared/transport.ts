import { ImapFlow, type MailboxObject } from 'imapflow';
import type { ICredentialsDecrypted, ICredentialTestFunctions, INodeCredentialTestResult } from 'n8n-workflow';
import type { YandexMailCredentials } from '../../credentials/YandexMailApi.credentials';
import { CLIENT_NAME, CLIENT_VERSION, IMAP_PORT, TRANSIENT_RETRIES } from './constants';
import { formatYandexError, isAuthError, isTransientImapError, YandexMailError } from './errors';
import { parseRawMessage, type ParsedYandexMessage } from './parse';

export type YandexFolder = {
	path: string;
	name: string;
	delimiter: string;
	flags: string[];
	specialUse: string;
	isInbox: boolean;
	isJunk: boolean;
	isTrash: boolean;
	isSent: boolean;
};

export type YandexFolderStatus = {
	path: string;
	messages: number;
	unseen: number;
	uidNext: number;
	uidValidity: number;
};

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function readCredentials(raw: unknown): YandexMailCredentials {
	const data = raw as Partial<YandexMailCredentials>;
	const user = (data.user ?? '').trim();
	const appPassword = data.appPassword ?? '';
	const server = data.server === 'imap.ya.ru' ? 'imap.ya.ru' : 'imap.yandex.ru';
	if (!user || !appPassword) {
		throw new YandexMailError('Yandex Mail credentials require Email and App Password.');
	}
	return { user, appPassword, server };
}

export function createClient(creds: YandexMailCredentials): ImapFlow {
	return new ImapFlow({
		host: creds.server,
		port: IMAP_PORT,
		secure: true,
		logger: false,
		disableAutoIdle: true,
		connectionTimeout: 20000,
		greetingTimeout: 20000,
		socketTimeout: 30000,
		clientInfo: {
			name: CLIENT_NAME,
			version: CLIENT_VERSION,
		},
		auth: {
			user: creds.user,
			pass: creds.appPassword,
		},
	});
}

async function safeLogout(client: ImapFlow): Promise<void> {
	try {
		if (!client.usable) {
			client.close();
			return;
		}
		await client.logout();
	} catch {
		try {
			client.close();
		} catch {
			// ignore
		}
	}
}

export async function connectYandex(creds: YandexMailCredentials): Promise<{
	client: ImapFlow;
	greetingMs: number;
	capabilities: string[];
}> {
	const client = createClient(creds);
	const started = Date.now();
	try {
		await client.connect();
	} catch (err) {
		await safeLogout(client);
		throw new YandexMailError(formatYandexError(err));
	}
	const capabilities = [...(client.capabilities?.keys() ?? [])];
	return { client, greetingMs: Date.now() - started, capabilities };
}

export async function withYandexClient<T>(
	creds: YandexMailCredentials,
	fn: (client: ImapFlow, greetingMs: number) => Promise<T>,
	retries = TRANSIENT_RETRIES,
): Promise<T> {
	let lastError: unknown;
	for (let attempt = 0; attempt < retries; attempt++) {
		try {
			const { client, greetingMs } = await connectYandex(creds);
			try {
				return await fn(client, greetingMs);
			} finally {
				await safeLogout(client);
			}
		} catch (err) {
			lastError = err;
			if (isAuthError(err) || !isTransientImapError(err) || attempt === retries - 1) {
				throw err instanceof YandexMailError ? err : new YandexMailError(formatYandexError(err));
			}
			await sleep(400 * 2 ** attempt);
		}
	}
	throw lastError instanceof YandexMailError ? lastError : new YandexMailError(formatYandexError(lastError));
}

function flagList(flags: Set<string> | string[] | undefined): string[] {
	if (!flags) {
		return [];
	}
	return [...flags];
}

export async function listFolders(client: ImapFlow): Promise<YandexFolder[]> {
	const listed = await client.list();
	return listed.map((item) => {
		const flags = flagList(item.flags);
		const specialUse = item.specialUse || '';
		const lowFlags = flags.map((flag) => flag.toLowerCase());
		return {
			path: item.path,
			name: item.name || item.path,
			delimiter: item.delimiter || '|',
			flags,
			specialUse,
			isInbox: specialUse === '\\Inbox' || item.path.toUpperCase() === 'INBOX' || lowFlags.includes('\\inbox'),
			isJunk:
				specialUse === '\\Junk' ||
				lowFlags.includes('\\junk') ||
				lowFlags.includes('\\spam') ||
				item.path.toLowerCase() === 'spam',
			isTrash: specialUse === '\\Trash' || lowFlags.includes('\\trash') || item.path.toLowerCase() === 'trash',
			isSent: specialUse === '\\Sent' || lowFlags.includes('\\sent') || item.path.toLowerCase() === 'sent',
		};
	});
}

export function resolvePollFolders(folders: YandexFolder[], selected: string[], includeJunk: boolean): string[] {
	const paths = new Set<string>();
	for (const path of selected) {
		if (path) {
			paths.add(path);
		}
	}
	if (paths.size === 0) {
		paths.add('INBOX');
	}
	if (includeJunk) {
		const junk = folders.find((folder) => folder.isJunk);
		if (junk) {
			paths.add(junk.path);
		}
	}
	return [...paths];
}

const PROTECTED_FOLDERS = new Set(['inbox', 'sent', 'trash', 'spam', 'drafts', 'outbox']);

function isProtectedFolder(folder: YandexFolder | undefined, path: string): boolean {
	if (!folder) {
		return PROTECTED_FOLDERS.has(path.trim().toLowerCase());
	}
	return Boolean(folder.isInbox || folder.isJunk || folder.isTrash || folder.isSent || folder.specialUse);
}

export async function createFolder(
	client: ImapFlow,
	path: string,
): Promise<{ path: string; created: boolean; existed: boolean }> {
	const name = path.trim();
	if (!name) {
		throw new YandexMailError('Folder path is required.');
	}
	const folders = await listFolders(client);
	if (folders.some((folder) => folder.path === name)) {
		return { path: name, created: false, existed: true };
	}
	await client.mailboxCreate(name);
	return { path: name, created: true, existed: false };
}

export async function deleteFolder(
	client: ImapFlow,
	path: string,
): Promise<{ path: string; deleted: boolean }> {
	const name = path.trim();
	if (!name) {
		throw new YandexMailError('Folder path is required.');
	}
	const folders = await listFolders(client);
	const folder = folders.find((item) => item.path === name);
	if (!folder) {
		throw new YandexMailError(`Folder ${name} was not found.`);
	}
	if (isProtectedFolder(folder, name)) {
		throw new YandexMailError(`Refusing to delete system folder ${name}.`);
	}
	const status = await getFolderStatus(client, name);
	if (status.messages > 0) {
		throw new YandexMailError(
			`Folder ${name} still has ${status.messages} message(s). Move or delete them first.`,
		);
	}
	await client.mailboxDelete(name);
	return { path: name, deleted: true };
}

export async function appendMessage(
	client: ImapFlow,
	mailbox: string,
	input: { subject: string; text: string; from?: string; to?: string; messageId?: string },
): Promise<{ uid: number; mailbox: string; messageId: string; appended: boolean }> {
	const folder = mailbox.trim() || 'INBOX';
	const messageId = normalizeMessageId(
		input.messageId || `n8n-yandex-test.${Date.now()}.${Math.random().toString(36).slice(2)}@n8n.test`,
	);
	const from = (input.from || 'n8n-yandex-mail-tests@n8n.test').trim();
	const to = (input.to || from).trim();
	const raw = [
		`From: ${from}`,
		`To: ${to}`,
		`Subject: ${input.subject || '(no subject)'}`,
		`Message-ID: <${messageId}>`,
		`Date: ${new Date().toUTCString()}`,
		'MIME-Version: 1.0',
		'Content-Type: text/plain; charset=utf-8',
		'',
		input.text || '',
	].join('\r\n');
	const result = await client.append(folder, Buffer.from(raw, 'utf8'));
	let uid = 0;
	if (result && typeof result === 'object' && 'uid' in result) {
		uid = Number(result.uid ?? 0);
	}
	if (!uid) {
		uid = await searchUidByMessageId(client, folder, messageId);
	}
	if (!uid) {
		throw new YandexMailError(`Appended to ${folder}, but the new UID was not returned.`);
	}
	return { uid, mailbox: folder, messageId, appended: true };
}

export async function getFolderStatus(client: ImapFlow, path: string): Promise<YandexFolderStatus> {
	const status = await client.status(path, {
		messages: true,
		unseen: true,
		uidNext: true,
		uidValidity: true,
	});
	return {
		path,
		messages: Number(status.messages ?? 0),
		unseen: Number(status.unseen ?? 0),
		uidNext: Number(status.uidNext ?? 1),
		uidValidity: Number(status.uidValidity ?? 0),
	};
}

export async function fetchMessagesByUid(
	client: ImapFlow,
	mailbox: string,
	uids: number[],
	markSeen: boolean,
): Promise<ParsedYandexMessage[]> {
	if (!uids.length) {
		return [];
	}
	const lock = await client.getMailboxLock(mailbox);
	const raw: Array<{ uid: number; flags: string[]; size: number; source: Buffer }> = [];
	try {
		// imapflow allows one command in flight. STORE inside this FETCH
		// iterator kills the socket and surfaces as "Connection not available".
		for await (const msg of client.fetch(
			uids,
			{ uid: true, flags: true, source: true, size: true, envelope: true },
			{ uid: true },
		)) {
			if (!msg.source || !msg.uid) {
				continue;
			}
			raw.push({
				uid: msg.uid,
				flags: flagList(msg.flags),
				size: msg.size ?? msg.source.length,
				source: Buffer.from(msg.source),
			});
		}
		if (markSeen && raw.length) {
			await client.messageFlagsAdd(
				raw.map((item) => item.uid),
				['\\Seen'],
				{ uid: true },
			);
			for (const item of raw) {
				if (!item.flags.includes('\\Seen')) {
					item.flags.push('\\Seen');
				}
			}
		}
	} finally {
		lock.release();
	}
	const out: ParsedYandexMessage[] = [];
	for (const item of raw) {
		out.push(
			await parseRawMessage(item.source, {
				uid: item.uid,
				mailbox,
				flags: item.flags,
				size: item.size,
			}),
		);
	}
	return out.sort((a, b) => a.uid - b.uid);
}

export async function getMailboxMeta(
	client: ImapFlow,
	mailbox: string,
): Promise<{ uidNext: number; uidValidity: number }> {
	const status = await getFolderStatus(client, mailbox);
	return { uidNext: status.uidNext, uidValidity: status.uidValidity };
}

export type YandexMoveResult = {
	uid: number;
	mailbox: string;
	source_mailbox: string;
	previousUid: number;
	previousMailbox: string;
	messageId: string;
	moved: boolean;
	alreadyInDestination: boolean;
};

function normalizeMessageId(value: string): string {
	return value.trim().replace(/^<|>$/g, '');
}

const ENVELOPE_SCAN_LIMIT = 400;

export async function searchUidByMessageId(
	client: ImapFlow,
	mailbox: string,
	messageId: string,
): Promise<number> {
	const raw = normalizeMessageId(messageId);
	if (!raw) {
		return 0;
	}
	const lock = await client.getMailboxLock(mailbox);
	try {
		for (const headerName of ['Message-ID', 'Message-Id', 'message-id']) {
			for (const value of [raw, `<${raw}>`]) {
				const found = await client.search({ header: { [headerName]: value } }, { uid: true });
				const uids = found === false ? [] : found.map((uid: number) => Number(uid)).filter((uid) => uid > 0);
				if (uids.length) {
					return uids[0];
				}
			}
		}

		// Yandex often ignores HEADER Message-ID. Scan recent envelopes in this folder.
		const box = client.mailbox as MailboxObject | false;
		const uidNext = Number(box && box.uidNext ? box.uidNext : 1);
		const fromUid = Math.max(1, uidNext - ENVELOPE_SCAN_LIMIT);
		for await (const msg of client.fetch(`${fromUid}:*`, { uid: true, envelope: true }, { uid: true })) {
			const id = normalizeMessageId(String(msg.envelope?.messageId ?? ''));
			if (id && id === raw && msg.uid) {
				return Number(msg.uid);
			}
		}
		return 0;
	} finally {
		lock.release();
	}
}

async function readMessageMeta(
	client: ImapFlow,
	mailbox: string,
	uid: number,
): Promise<{ exists: boolean; messageId: string }> {
	const lock = await client.getMailboxLock(mailbox);
	try {
		const msg = await client.fetchOne(String(uid), { uid: true, envelope: true }, { uid: true });
		if (!msg || Number(msg.uid) !== uid) {
			return { exists: false, messageId: '' };
		}
		return { exists: true, messageId: normalizeMessageId(String(msg.envelope?.messageId ?? '')) };
	} finally {
		lock.release();
	}
}

export async function locateMessage(
	client: ImapFlow,
	mailbox: string,
	uid: number,
	messageId: string,
	alsoCheck: string[] = [],
): Promise<{ mailbox: string; uid: number; messageId: string }> {
	const normalizedId = normalizeMessageId(messageId);
	if (uid > 0) {
		const meta = await readMessageMeta(client, mailbox, uid);
		if (meta.exists && (!normalizedId || !meta.messageId || meta.messageId === normalizedId)) {
			return { mailbox, uid, messageId: meta.messageId || normalizedId };
		}
	}
	if (normalizedId) {
		const folders = await listFolders(client);
		const extras = alsoCheck.filter((path) => path && path !== mailbox);
		const rest = folders.filter((folder) => {
			const path = folder.path;
			if (!path || path === mailbox || extras.includes(path)) {
				return false;
			}
			// System folders are skipped unless they are the start mailbox or alsoCheck
			// (destination). Otherwise Copy/Trash leftovers steal the first Message-ID hit
			// and a 400-envelope scan of Sent/Trash/Spam/INBOX adds tens of seconds.
			if (folder.isTrash || folder.isJunk || folder.isSent || folder.isInbox) {
				return false;
			}
			return true;
		});
		const others = rest.map((folder) => folder.path);
		const order = [mailbox, ...extras, ...others];
		const seen = new Set<string>();
		for (const path of order) {
			if (!path || seen.has(path)) {
				continue;
			}
			seen.add(path);
			const found = await searchUidByMessageId(client, path, normalizedId);
			if (found) {
				return { mailbox: path, uid: found, messageId: normalizedId };
			}
		}
	}
	throw new YandexMailError(
		uid > 0
			? `Message UID ${uid} was not found in ${mailbox}${normalizedId ? ` (Message-ID ${normalizedId})` : ''}`
			: `Message-ID ${normalizedId || '(empty)'} was not found`,
	);
}

async function transferMessage(
	client: ImapFlow,
	mailbox: string,
	destination: string,
	uid: number,
	messageId: string,
	mode: 'move' | 'copy',
): Promise<YandexMoveResult> {
	const from = mailbox.trim();
	const to = destination.trim();
	if (!to) {
		throw new YandexMailError('Destination folder is required.');
	}
	const located = await locateMessage(client, from, uid, messageId, [to]);
	const resolvedId =
		located.messageId || (await readMessageMeta(client, located.mailbox, located.uid)).messageId;
	if (mode === 'move' && located.mailbox === to) {
		return {
			uid: located.uid,
			mailbox: to,
			source_mailbox: to,
			previousUid: located.uid,
			previousMailbox: located.mailbox,
			messageId: resolvedId,
			moved: false,
			alreadyInDestination: true,
		};
	}

	const lock = await client.getMailboxLock(located.mailbox);
	let destUid = 0;
	try {
		const result =
			mode === 'move'
				? await client.messageMove(String(located.uid), to, { uid: true })
				: await client.messageCopy(String(located.uid), to, { uid: true });
		if (!result) {
			throw new YandexMailError(
				`${mode.toUpperCase()} of UID ${located.uid} from ${located.mailbox} to ${to} failed`,
			);
		}
		destUid = Number(result.uidMap?.get(located.uid) ?? 0);
	} finally {
		lock.release();
	}

	if (!destUid && resolvedId) {
		destUid = await searchUidByMessageId(client, to, resolvedId);
	}
	if (!destUid) {
		throw new YandexMailError(
			`${mode === 'move' ? 'Moved' : 'Copied'} UID ${located.uid} to ${to}, but the new UID was not returned. Keep Message-ID ${resolvedId || '(missing)'} to find it again.`,
		);
	}

	return {
		uid: destUid,
		mailbox: to,
		source_mailbox: to,
		previousUid: located.uid,
		previousMailbox: located.mailbox,
		messageId: resolvedId,
		moved: mode === 'move',
		alreadyInDestination: false,
	};
}

export async function moveMessage(
	client: ImapFlow,
	mailbox: string,
	destination: string,
	uid: number,
	messageId: string,
): Promise<YandexMoveResult> {
	return await transferMessage(client, mailbox, destination, uid, messageId, 'move');
}

export async function copyMessage(
	client: ImapFlow,
	mailbox: string,
	destination: string,
	uid: number,
	messageId: string,
): Promise<YandexMoveResult> {
	return await transferMessage(client, mailbox, destination, uid, messageId, 'copy');
}

export type YandexFlagAction = 'seen' | 'unseen' | 'flagged' | 'unflagged';

export async function markMessage(
	client: ImapFlow,
	mailbox: string,
	uid: number,
	messageId: string,
	action: YandexFlagAction,
): Promise<{ uid: number; mailbox: string; source_mailbox: string; messageId: string; flags: string[]; action: YandexFlagAction }> {
	const located = await locateMessage(client, mailbox, uid, messageId);
	const lock = await client.getMailboxLock(located.mailbox);
	try {
		const add = action === 'seen' || action === 'flagged';
		const flag = action === 'seen' || action === 'unseen' ? '\\Seen' : '\\Flagged';
		const ok = add
			? await client.messageFlagsAdd(String(located.uid), [flag], { uid: true })
			: await client.messageFlagsRemove(String(located.uid), [flag], { uid: true });
		if (!ok) {
			throw new YandexMailError(`Could not ${action} UID ${located.uid} in ${located.mailbox}`);
		}
		const msg = await client.fetchOne(String(located.uid), { uid: true, flags: true }, { uid: true });
		return {
			uid: located.uid,
			mailbox: located.mailbox,
			source_mailbox: located.mailbox,
			messageId: located.messageId,
			flags: msg ? flagList(msg.flags) : [],
			action,
		};
	} finally {
		lock.release();
	}
}

export async function deleteMessage(
	client: ImapFlow,
	mailbox: string,
	uid: number,
	messageId: string,
	mode: 'trash' | 'permanent',
): Promise<YandexMoveResult & { deleted: boolean; mode: 'trash' | 'permanent' }> {
	if (mode === 'trash') {
		const folders = await listFolders(client);
		const trash = folders.find((folder) => folder.isTrash)?.path;
		if (!trash) {
			throw new YandexMailError('Mailbox has no Trash folder (XLIST \\Trash).');
		}
		const moved = await moveMessage(client, mailbox, trash, uid, messageId);
		return { ...moved, deleted: true, mode };
	}

	const located = await locateMessage(client, mailbox, uid, messageId);
	const lock = await client.getMailboxLock(located.mailbox);
	try {
		const ok = await client.messageDelete(String(located.uid), { uid: true });
		if (!ok) {
			throw new YandexMailError(`Could not permanently delete UID ${located.uid} in ${located.mailbox}`);
		}
	} finally {
		lock.release();
	}
	return {
		uid: 0,
		mailbox: located.mailbox,
		source_mailbox: located.mailbox,
		previousUid: located.uid,
		previousMailbox: located.mailbox,
		messageId: located.messageId,
		moved: false,
		alreadyInDestination: false,
		deleted: true,
		mode,
	};
}

export async function searchNewUids(
	client: ImapFlow,
	mailbox: string,
	fromUid: number,
	limit: number,
): Promise<{
	uids: number[];
	uidNext: number;
	uidValidity: number;
}> {
	const lock = await client.getMailboxLock(mailbox);
	try {
		const box = client.mailbox as MailboxObject | false;
		if (!box) {
			throw new YandexMailError(`Failed to select ${mailbox}`);
		}
		const uidValidity = Number(box.uidValidity ?? 0);
		const uidNext = Number(box.uidNext ?? 1);
		if (fromUid >= uidNext || limit <= 0) {
			return { uids: [], uidNext, uidValidity };
		}
		const found = await client.search({ uid: `${fromUid}:*` }, { uid: true });
		const uidList = found === false ? [] : found;
		const uids = uidList
			.map((uid: number) => Number(uid))
			.filter((uid: number) => uid >= fromUid)
			.sort((a: number, b: number) => a - b);
		return { uids: uids.slice(0, limit), uidNext, uidValidity };
	} finally {
		lock.release();
	}
}

export async function diagnoseMailbox(creds: YandexMailCredentials): Promise<IDataObjectLike> {
	return await withYandexClient(creds, async (client, greetingMs) => {
		const folders = await listFolders(client);
		const inbox = folders.find((folder) => folder.isInbox)?.path ?? 'INBOX';
		const junk = folders.find((folder) => folder.isJunk)?.path;
		const inboxStatus = await getFolderStatus(client, inbox);
		const junkStatus = junk ? await getFolderStatus(client, junk) : null;
		return {
			ok: true,
			host: creds.server,
			user: creds.user,
			greetingMs,
			idleAdvertised: Boolean(client.capabilities?.has('IDLE')),
			idleUsed: false,
			idSent: true,
			capabilities: [...(client.capabilities?.keys() ?? [])],
			hierarchyDelimiter: folders[0]?.delimiter ?? '|',
			folders: folders.map((folder) => ({
				path: folder.path,
				flags: folder.flags,
				specialUse: folder.specialUse,
				isInbox: folder.isInbox,
				isJunk: folder.isJunk,
			})),
			inbox: inboxStatus,
			spam: junkStatus,
		};
	});
}

type IDataObjectLike = Record<string, unknown>;

export async function yandexMailConnectionTest(
	this: ICredentialTestFunctions,
	credential: ICredentialsDecrypted,
): Promise<INodeCredentialTestResult> {
	try {
		const creds = readCredentials(credential.data);
		const report = await diagnoseMailbox(creds);
		const inbox = report.inbox as YandexFolderStatus;
		return {
			status: 'OK',
			message: `Connected to ${creds.server}. INBOX UIDNEXT ${inbox.uidNext}, unseen ${inbox.unseen}. IDLE is advertised and not used.`,
		};
	} catch (err) {
		return {
			status: 'Error',
			message: formatYandexError(err),
		};
	}
}
