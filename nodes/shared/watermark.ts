export type FolderCursor = {
	uidValidity: number;
	lastUid: number;
};

export type TriggerStaticData = {
	folders?: Record<string, FolderCursor>;
	lastSuccessAt?: string;
	lastError?: string;
	consecutiveFailures?: number;
	alertSent?: boolean;
	nextPollAfter?: number;
	lastGreetingMs?: number;
};

export function resolveCursor(
	uidValidity: number,
	uidNext: number,
	cursor: FolderCursor | undefined,
	fetchOnlyNew: boolean,
): { fromUid: number; skipFetch: boolean; validityChanged: boolean; nextIfEmpty: FolderCursor } {
	const validityChanged = Boolean(cursor && cursor.uidValidity !== uidValidity);
	const effective = !cursor || validityChanged ? undefined : cursor;

	if (!effective) {
		if (fetchOnlyNew) {
			const lastUid = Math.max(0, uidNext - 1);
			return {
				fromUid: uidNext,
				skipFetch: true,
				validityChanged,
				nextIfEmpty: { uidValidity, lastUid },
			};
		}
		return {
			fromUid: 1,
			skipFetch: uidNext <= 1,
			validityChanged,
			nextIfEmpty: { uidValidity, lastUid: Math.max(0, uidNext - 1) },
		};
	}

	const fromUid = effective.lastUid + 1;
	return {
		fromUid,
		skipFetch: fromUid >= uidNext,
		validityChanged: false,
		nextIfEmpty: effective,
	};
}

export function parseExcludeSenders(raw: string): string[] {
	return raw
		.split(/[,;\n]+/)
		.map((item) => item.trim().toLowerCase())
		.filter(Boolean);
}
