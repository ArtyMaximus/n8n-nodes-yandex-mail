import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import type { IDataObject } from 'n8n-workflow';

export type ParsedYandexMessage = {
	uid: number;
	mailbox: string;
	source_mailbox: string;
	subject: string;
	from: string;
	fromEmail: string;
	to: string;
	cc: string;
	date: string;
	html: string;
	text: string;
	textAsHtml: string;
	messageId: string;
	inReplyTo: string;
	references: string[];
	headers: IDataObject;
	flags: string[];
	size: number;
	hasAttachments: boolean;
	attachmentsNote: string;
};

function addressList(value?: AddressObject | AddressObject[]): string {
	if (!value) {
		return '';
	}
	const items = Array.isArray(value) ? value : [value];
	return items
		.flatMap((item) =>
			(item.value ?? []).map((entry) => {
				if (entry.name && entry.address) {
					return `${entry.name} <${entry.address}>`;
				}
				return entry.address || entry.name || '';
			}),
		)
		.filter(Boolean)
		.join(', ');
}

function firstEmail(value?: AddressObject | AddressObject[]): string {
	if (!value) {
		return '';
	}
	const items = Array.isArray(value) ? value : [value];
	for (const item of items) {
		for (const entry of item.value ?? []) {
			if (entry.address) {
				return entry.address.toLowerCase();
			}
		}
	}
	return '';
}

function asStringArray(value: unknown): string[] {
	if (!value) {
		return [];
	}
	if (Array.isArray(value)) {
		return value.map((item) => String(item)).filter(Boolean);
	}
	return String(value)
		.split(/\s+/)
		.map((item) => item.trim())
		.filter(Boolean);
}

function headerScalar(value: unknown): string {
	if (value == null) {
		return '';
	}
	if (value instanceof Date) {
		return value.toISOString();
	}
	if (typeof value === 'object') {
		const obj = value as { text?: string; value?: Array<{ name?: string; address?: string }> };
		if (typeof obj.text === 'string' && obj.text) {
			return obj.text;
		}
		if (Array.isArray(obj.value)) {
			return obj.value
				.map((entry) => {
					if (entry.name && entry.address) {
						return `${entry.name} <${entry.address}>`;
					}
					return entry.address || entry.name || '';
				})
				.filter(Boolean)
				.join(', ');
		}
		try {
			return JSON.stringify(value);
		} catch {
			return '';
		}
	}
	return String(value);
}

function headerObject(parsed: ParsedMail): IDataObject {
	const headers: IDataObject = {};
	parsed.headers.forEach((value, key) => {
		if (Array.isArray(value)) {
			headers[key] = value.map((item) => headerScalar(item));
		} else {
			headers[key] = headerScalar(value);
		}
	});
	return headers;
}

export async function parseRawMessage(source: Buffer, meta: {
	uid: number;
	mailbox: string;
	flags: string[];
	size: number;
}): Promise<ParsedYandexMessage> {
	const parsed = await simpleParser(source, { skipImageLinks: true });
	const html = typeof parsed.html === 'string' ? parsed.html : '';
	const text = parsed.text ?? '';
	const attachments = parsed.attachments ?? [];

	return {
		uid: meta.uid,
		mailbox: meta.mailbox,
		source_mailbox: meta.mailbox,
		subject: parsed.subject ?? '',
		from: addressList(parsed.from),
		fromEmail: firstEmail(parsed.from),
		to: addressList(parsed.to),
		cc: addressList(parsed.cc),
		date: parsed.date ? parsed.date.toISOString() : '',
		html,
		text,
		textAsHtml: parsed.textAsHtml ?? '',
		messageId: (parsed.messageId ?? '').replace(/^<|>$/g, ''),
		inReplyTo: (parsed.inReplyTo ?? '').replace(/^<|>$/g, ''),
		references: asStringArray(parsed.references).map((item) => item.replace(/^<|>$/g, '')),
		headers: headerObject(parsed),
		flags: meta.flags,
		size: meta.size || source.length,
		hasAttachments: attachments.length > 0,
		attachmentsNote:
			attachments.length > 0
				? `есть (${attachments.length}, содержимое не скачивается)`
				: '',
	};
}

export function messagePassesFilters(
	message: ParsedYandexMessage,
	filters: { excludeSenders: string[]; subjectIgnoreRegex: string; maxSizeKb: number },
): boolean {
	if (filters.excludeSenders.length && filters.excludeSenders.includes(message.fromEmail)) {
		return false;
	}
	if (filters.subjectIgnoreRegex) {
		try {
			const re = new RegExp(filters.subjectIgnoreRegex, 'i');
			if (re.test(message.subject)) {
				return false;
			}
		} catch {
			// Invalid regex is ignored so a typo does not drop the poll.
		}
	}
	if (filters.maxSizeKb > 0 && message.size > filters.maxSizeKb * 1024) {
		return false;
	}
	return true;
}
