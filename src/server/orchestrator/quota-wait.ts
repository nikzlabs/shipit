// docs/306-quota-continuation — when an automatic wake that every credential refused for quota
// runs again. Shared by its two owners: the self merge watch and QuotaContinuationManager.

import { REFUSAL_REPROBE_MS } from "../shared/types/domain-types/credential-route.js";

// This many refusals in a row end the wait, so quota that never returns cannot wake a session for ever.
export const MAX_QUOTA_REFUSALS = 5;
// A provider's reset time is to the minute; a wake on that second can be refused again.
const QUOTA_RESET_MARGIN_MS = 60_000;
const MIN_WAIT_MS = 60_000;
const MAX_MIN_WAIT_MS = 10 * 60_000;

/**
 * The earliest reset a refusal stated. One that stated none is tried again when the router would
 * probe that credential again (docs/260). Never sooner than a backoff that grows with `refusals`.
 */
export function quotaWaitUntil(resetsAt: readonly (string | null)[], refusals: number, now: number): number {
  const times = resetsAt.map((at) => {
    const stated = at === null ? Number.NaN : Date.parse(at);
    return Number.isFinite(stated) ? stated + QUOTA_RESET_MARGIN_MS : now + REFUSAL_REPROBE_MS;
  });
  const earliest = times.length > 0 ? Math.min(...times) : now + REFUSAL_REPROBE_MS;
  const floor = Math.min(MIN_WAIT_MS * 2 ** Math.max(0, refusals - 1), MAX_MIN_WAIT_MS);
  return Math.max(earliest, now + floor);
}

export function formatUtc(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
