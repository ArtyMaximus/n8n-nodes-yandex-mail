import { simpleParser, type AddressObject, type Attachment, type ParsedMail } from 'mailparser';
import type { IDataObject } from 'n8n-workflow';

export type YandexAttachmentMeta = {
	filename: string;
	contentType: string;
	size: number;
	contentDisposition: string;
	cid: string;
	inline: boolean;
};

export type YandexAttachmentFile = YandexAttachmentMeta & {
	content: Buffer;
};

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
	attachments: YandexAttachmentMeta[];
	attachmentsNote: string;
};

export type ParsedYandexEnvelope = {
	message: ParsedYandexMessage;
	files: YandexAttachmentFile[];
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

function isInlineAttachment(attachment: Attachment): boolean {
	const disposition = String(attachment.contentDisposition || '').toLowerCase();
	if (disposition === 'attachment') {
		return false;
	}
	if (disposition === 'inline') {
		return true;
	}
	if (attachment.related) {
		return true;
	}
	return Boolean(attachment.cid);
}

function toAttachmentFile(attachment: Attachment, index: number): YandexAttachmentFile | null {
	if (!attachment.content || !attachment.content.length) {
		return null;
	}
	const filename = (attachment.filename || `attachment-${index + 1}`).trim() || `attachment-${index + 1}`;
	const contentType = (attachment.contentType || 'application/octet-stream').trim();
	return {
		filename,
		contentType,
		size: attachment.size || attachment.content.length,
		contentDisposition: String(attachment.contentDisposition || ''),
		cid: String(attachment.cid || ''),
		inline: isInlineAttachment(attachment),
		content: Buffer.from(attachment.content),
	};
}

export function selectAttachmentFiles(
	files: YandexAttachmentFile[],
	includeInline: boolean,
): YandexAttachmentFile[] {
	return includeInline ? files : files.filter((file) => !file.inline);
}

export async function parseRawMessage(
	source: Buffer,
	meta: {
		uid: number;
		mailbox: string;
		flags: string[];
		size: number;
	},
): Promise<ParsedYandexEnvelope> {
	const parsed = await simpleParser(source, { skipImageLinks: true });
	const html = typeof parsed.html === 'string' ? parsed.html : '';
	const text = parsed.text ?? '';
	const files = (parsed.attachments ?? [])
		.map((attachment, index) => toAttachmentFile(attachment, index))
		.filter((item): item is YandexAttachmentFile => Boolean(item));
	const attachments: YandexAttachmentMeta[] = files.map(({ content: _content, ...rest }) => rest);
	const names = attachments.map((item) => item.filename).filter(Boolean);

	return {
		message: {
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
			hasAttachments: attachments.some((item) => !item.inline) || attachments.length > 0,
			attachments,
			attachmentsNote: names.length ? `есть (${names.length}): ${names.join(', ')}` : '',
		},
		files,
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
