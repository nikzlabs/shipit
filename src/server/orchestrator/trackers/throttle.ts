/**
 * Vendor-neutral throttle plumbing shared by the tracker adapters.
 *
 * A rate limit is not an access failure, but the two are easy to confuse:
 * GitHub reports a secondary rate limit as a `403` — the same status an
 * unreachable repository produces. docs/247's migration lost half an hour to
 * exactly that: at ~870 writes in 15 minutes every subsequent write was reported
 * as "the repository either does not exist or the connected GitHub credential
 * cannot access it", which sent the operator to check the slug and re-grant
 * access, the two things guaranteed not to help.
 *
 * What lives here is only the part that is the same for every backend: reading
 * the standard `Retry-After` header, and rendering "how long to wait" for a
 * human. What counts AS a throttle is vendor-specific and stays in each adapter.
 */

/**
 * `Retry-After` in seconds, or null when absent/unparseable. RFC 9110 allows
 * either a delta-seconds integer (what GitHub sends) or an HTTP-date, so both
 * are accepted. A date already in the past yields 0, not a negative wait.
 */
export function parseRetryAfterSeconds(res: Response): number | null {
  const raw = res.headers.get("retry-after")?.trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  const when = Date.parse(raw);
  if (Number.isNaN(when)) return null;
  return Math.max(0, Math.round((when - Date.now()) / 1000));
}

/**
 * Seconds remaining until a Unix-epoch-seconds deadline (the shape of GitHub's
 * `x-ratelimit-reset`), floored at 0. Null in, null out.
 */
export function secondsUntilEpoch(epochSeconds: number | null): number | null {
  if (epochSeconds === null) return null;
  return Math.max(0, epochSeconds - Math.floor(Date.now() / 1000));
}

/**
 * A wait rendered for a human reading an error message: "45 seconds", "8
 * minutes", or a vague "a few minutes" when the backend did not say. Rounds up
 * so retrying at the stated time is never early.
 */
export function waitPhrase(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || seconds <= 0) return "a few minutes";
  if (seconds < 90) return `${Math.ceil(seconds)} seconds`;
  return `${Math.ceil(seconds / 60)} minutes`;
}
