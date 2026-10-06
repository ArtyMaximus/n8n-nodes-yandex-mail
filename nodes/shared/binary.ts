import type { IBinaryKeyData, IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import {
	selectAttachmentFiles,
	type ParsedYandexEnvelope,
	type YandexAttachmentFile,
	type YandexAttachmentMeta,
} from './parse';
import { buildYandexMessageWebUrl } from './webUrl';

type BinaryHelpers = Pick<IExecuteFunctions['helpers'], 'prepareBinaryData' | 'getBinaryDataBuffer'>;

export const DEFAULT_ATTACHMENT_PREFIX = 'attachment_';

export type PublishedAttachment = YandexAttachmentMeta & {
	index: number;
	binaryProperty: string;
};

export function publishAttachmentList(
	files: YandexAttachmentFile[],
	prefix = DEFAULT_ATTACHMENT_PREFIX,
	includeInline = false,
): { files: YandexAttachmentFile[]; attachments: PublishedAttachment[] } {
	const selected = selectAttachmentFiles(files, includeInline);
	return {
		files: selected,
		attachments: selected.map((file, index) => ({
			filename: file.filename,
			contentType: file.contentType,
			size: file.size,
			contentDisposition: file.contentDisposition,
			cid: file.cid,
			inline: file.inline,
			index,
			binaryProperty: `${prefix}${index}`,
		})),
	};
}

export async function filesToBinary(
	helpers: Pick<BinaryHelpers, 'prepareBinaryData'>,
	files: YandexAttachmentFile[],
	prefix = DEFAULT_ATTACHMENT_PREFIX,
	includeInline = false,
): Promise<IBinaryKeyData> {
	const binary: IBinaryKeyData = {};
	const selected = publishAttachmentList(files, prefix, includeInline).files;
	for (let i = 0; i < selected.length; i++) {
		const file = selected[i];
		binary[`${prefix}${i}`] = await helpers.prepareBinaryData(file.content, file.filename, file.contentType);
	}
	return binary;
}

export async function envelopeToItem(
	helpers: Pick<BinaryHelpers, 'prepareBinaryData'>,
	envelope: ParsedYandexEnvelope,
	options: { downloadAttachments: boolean; includeInline: boolean; prefix: string; accountUid?: string },
): Promise<INodeExecutionData> {
	const published = publishAttachmentList(envelope.files, options.prefix, options.includeInline);
	const names = published.attachments.map((item) => item.filename);
	const json = {
		...envelope.message,
		hasAttachments: published.attachments.length > 0,
		attachmentCount: published.attachments.length,
		attachments: published.attachments,
		attachmentsNote: names.length ? `есть (${names.length}): ${names.join(', ')}` : '',
		webUrl: buildYandexMessageWebUrl(options.accountUid ?? '', envelope.message.messageId),
	} as unknown as IDataObject;

	if (!options.downloadAttachments || !published.files.length) {
		return { json };
	}

	const binary = await filesToBinary(
		helpers,
		envelope.files,
		options.prefix,
		options.includeInline,
	);
	return {
		json,
		binary: Object.keys(binary).length ? binary : undefined,
	};
}

export async function collectOutgoingAttachments(
	helpers: Pick<BinaryHelpers, 'getBinaryDataBuffer'>,
	itemIndex: number,
	binary: IBinaryKeyData | undefined,
	spec: string,
): Promise<Array<{ filename: string; content: Buffer; contentType?: string }>> {
	const raw = spec.trim();
	if (!raw || !binary) {
		return [];
	}
	const keys =
		raw === '*'
			? Object.keys(binary)
			: raw
					.split(',')
					.map((key) => key.trim())
					.filter(Boolean);
	const out: Array<{ filename: string; content: Buffer; contentType?: string }> = [];
	for (const key of keys) {
		const meta = binary[key];
		if (!meta) {
			continue;
		}
		const content = await helpers.getBinaryDataBuffer(itemIndex, key);
		out.push({
			filename: meta.fileName || key,
			content,
			contentType: meta.mimeType,
		});
	}
	return out;
}
