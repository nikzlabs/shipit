// Applied during warming, not claiming; a break does not discard an existing warm preview.
export const WARM_PREVIEW_RECENCY_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export function isRecentlyUsedRepo(lastUsedAt: string | undefined, now = Date.now()): boolean {
  if (!lastUsedAt) return false;
  const ms = Date.parse(lastUsedAt);
  if (Number.isNaN(ms)) return false;
  return now - ms <= WARM_PREVIEW_RECENCY_DAYS * DAY_MS;
}
