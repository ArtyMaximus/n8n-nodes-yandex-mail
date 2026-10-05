import nodemailer from 'nodemailer';
import type { YandexMailCredentials } from '../../credentials/YandexMailApi.credentials';
import { SMTP_PORT } from './constants';
import { formatYandexError, YandexMailError } from './errors';

export type YandexSendAttachment = {
	filename: string;
	content: Buffer;
	contentType?: string;
};

export type YandexSendInput = {
	to: string;
	subject: string;
	text: string;
	html?: string;
	cc?: string;
	attachments?: YandexSendAttachment[];
};

export type YandexSendResult = {
	accepted: string[];
	rejected: string[];
	messageId: string;
	response: string;
	host: string;
	attachedCount: number;
	attachedFilenames: string[];
};

function smtpHost(server: YandexMailCredentials['server']): string {
	return server === 'imap.ya.ru' ? 'smtp.ya.ru' : 'smtp.yandex.ru';
}

function normalizeMessageId(value: string): string {
	return value.trim().replace(/^<|>$/g, '');
}

export async function sendMessage(
	creds: YandexMailCredentials,
	input: YandexSendInput,
): Promise<YandexSendResult> {
	const to = input.to.trim();
	if (!to) {
		throw new YandexMailError('Send requires a To address.');
	}
	const host = smtpHost(creds.server);
	const transport = nodemailer.createTransport({
		host,
		port: SMTP_PORT,
		secure: true,
		auth: {
			user: creds.user,
			pass: creds.appPassword,
		},
		connectionTimeout: 20000,
		greetingTimeout: 20000,
		socketTimeout: 30000,
	});
	try {
		const attached = input.attachments ?? [];
		const info = await transport.sendMail({
			from: creds.user,
			to,
			cc: input.cc?.trim() || undefined,
			subject: input.subject,
			text: input.text,
			html: input.html?.trim() || undefined,
			attachments: attached.length
				? attached.map((file) => ({
						filename: file.filename,
						content: file.content,
						contentType: file.contentType,
					}))
				: undefined,
		});
		return {
			accepted: (info.accepted ?? []).map(String),
			rejected: (info.rejected ?? []).map(String),
			messageId: normalizeMessageId(String(info.messageId ?? '')),
			response: String(info.response ?? ''),
			host,
			attachedCount: attached.length,
			attachedFilenames: attached.map((file) => file.filename),
		};
	} catch (err) {
		throw new YandexMailError(formatYandexError(err));
	} finally {
		transport.close();
	}
}
