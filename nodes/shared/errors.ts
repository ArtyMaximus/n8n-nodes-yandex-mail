function imapflowResponseText(err: unknown): string {
	if (!err || typeof err !== 'object') {
		return '';
	}
	const text = (err as { responseText?: unknown }).responseText;
	return typeof text === 'string' ? text.trim() : '';
}

export function errorMessage(err: unknown): string {
	const imapText = imapflowResponseText(err);
	if (err instanceof Error) {
		if (imapText && !err.message.includes(imapText)) {
			return `${err.message}: ${imapText}`;
		}
		return err.message;
	}
	return imapText || String(err);
}

export function errorCode(err: unknown): string {
	if (err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string') {
		return (err as { code: string }).code.toUpperCase();
	}
	return '';
}

export function extractSupportId(message: string): string {
	return message.match(/sc=([^\s]+)/)?.[1] ?? '';
}

export function isTransientImapError(err: unknown): boolean {
	const code = errorCode(err);
	if (['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ETIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) {
		return true;
	}
	const msg = errorMessage(err);
	return /socket|timeout|reset|econnreset|epipe|closed|not connected|connection/i.test(msg);
}

export function isAuthError(err: unknown): boolean {
	if (err && typeof err === 'object' && (err as { authenticationFailed?: unknown }).authenticationFailed === true) {
		return true;
	}
	const msg = errorMessage(err);
	return /AUTHENTICATIONFAILED|invalid credentials or IMAP is disabled|LOGIN failed|AUTHENTICATE/i.test(msg);
}

function errorSite(err: unknown): string {
	if (!err || typeof err !== 'object') {
		return '';
	}
	const site = err as { rejectedFrom?: unknown; command?: unknown };
	const from = typeof site.rejectedFrom === 'string' ? site.rejectedFrom : '';
	const command = typeof site.command === 'string' ? site.command : '';
	return [from, command].filter(Boolean).join('/');
}

export function formatYandexError(err: unknown): string {
	const msg = errorMessage(err);
	const code = errorCode(err);
	const site = errorSite(err);
	const sc = extractSupportId(msg);
	if (isAuthError(err)) {
		const hint =
			'Yandex rejected LOGIN. Enable IMAP in mailbox settings and use a Mail app password, not the account password.';
		return sc ? `${hint} Support id: ${sc}` : hint;
	}
	const extras = [code, site].filter(Boolean).join(' ');
	const withSite = extras && !msg.includes(extras) ? `${msg} (${extras})` : msg;
	return sc ? `${withSite} (support id: ${sc})` : withSite;
}

export class YandexMailError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'YandexMailError';
	}
}
