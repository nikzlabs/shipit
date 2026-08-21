import { createHash } from "node:crypto";

/**
 * Conditional-GET helpers for the big JSON reads (`/history`, `/files`).
 *
 * These exist because the obvious implementation — hash the body, then
 * `request.headers["if-none-match"] === etag` — does not survive contact with a
 * CDN, and fails SILENTLY when it doesn't: every request simply answers 200 and
 * the revalidation looks like it was never worth having.
 *
 * ShipIt is served through Cloudflare (`deployment/vps/cloudflare.sh`), which
 * re-compresses responses (a trace of production shows `content-encoding: zstd`)
 * and therefore **weakens the validator**: a strong `"abc"` leaves the origin and
 * reaches the browser as `W/"abc"`. The browser stores what it received and
 * echoes exactly that back in `If-None-Match`, so an exact-match comparison
 * against the origin's own strong tag can never match. Confirmed in a
 * 2026-08-16 production trace, where every `/history` and `/files` response came
 * back as `W/"…"` carrying our own base64url SHA-1 inside it.
 *
 * So: compare the OPAQUE TAG, ignoring the `W/` prefix. That is also what RFC
 * 9110 §8.8.3.2 prescribes — `If-None-Match` uses the *weak* comparison
 * function, under which `W/"abc"` and `"abc"` are a match. The strict
 * comparison is only for `If-Match` / range requests.
 */

/** `"abc"` and `W/"abc"` both reduce to `abc`. */
function opaqueTag(raw: string): string {
  const trimmed = raw.trim();
  const unweakened = trimmed.startsWith("W/") ? trimmed.slice(2) : trimmed;
  return unweakened.replace(/^"|"$/g, "");
}

/** A strong ETag over exactly the bytes about to be sent. */
export function etagFor(body: string): string {
  return `"${createHash("sha1").update(body).digest("base64url")}"`;
}

/**
 * planning#324 — a validator for a response with one part too big to rebuild
 * per request: a monotonic revision counter speaks for that part, and the
 * hash speaks for exactly the rest.
 *
 * `etagFor` requires the whole body in hand, which is what made every
 * `/history` revalidation rebuild and serialize the entire transcript just to
 * answer "unchanged". The transcript's own validator is
 * `ChatHistoryManager.revision()` — equal revisions mean zero writes happened,
 * which is a stronger statement than equal hashes — so only the small
 * remainder still needs hashing. Both halves keep the property the docstring
 * above is about: neither can silently forget a source, because the revision
 * is trigger-maintained and the remainder hash covers the exact object sent.
 *
 * Opaque to the client, compared (never parsed) via `matchesIfNoneMatch`.
 */
export function composedEtag(revision: number, remainder: string): string {
  return `"${revision}-${createHash("sha1").update(remainder).digest("base64url")}"`;
}

/**
 * Does the client already hold this exact representation?
 *
 * Handles the three things a real `If-None-Match` can be that a `===` cannot:
 * the weak form a CDN produces, the comma-separated list a browser may send
 * after following redirects, and `*`.
 */
export function matchesIfNoneMatch(header: string | string[] | undefined, etag: string): boolean {
  if (!header) return false;
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (raw.trim() === "*") return true;
  const want = opaqueTag(etag);
  return raw.split(",").some((candidate) => opaqueTag(candidate) === want);
}
