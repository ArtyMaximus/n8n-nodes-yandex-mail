export function normalizeYandexAccountUid(raw: string): string {
	const text = (raw ?? '').trim();
	if (!text) {
		return '';
	}
	const fromQuery = text.match(/[?&#]uid=(\d+)/i);
	if (fromQuery) {
		return fromQuery[1];
	}
	return /^\d+$/.test(text) ? text : '';
}

export function normalizeRfcMessageId(raw: string): string {
	return (raw ?? '').trim().replace(/^<|>$/g, '');
}

/**
 * Yandex web search by RFC Message-ID. IMAP UID and the web #/message/<mid>
 * are different ids; mid is not on IMAP headers, so this is the stable link.
 */
export function buildYandexMessageWebUrl(accountUid: string, messageId: string): string {
	const uid = normalizeYandexAccountUid(accountUid);
	const mid = normalizeRfcMessageId(messageId);
	if (!uid || !mid) {
		return '';
	}
	return `https://mail.360.yandex.ru/?uid=${encodeURIComponent(uid)}#search?request=msgid:${encodeURIComponent(mid)}`;
}
