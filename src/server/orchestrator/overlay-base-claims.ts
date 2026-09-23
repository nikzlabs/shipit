import crypto from "node:crypto";

/**
 * Protects a base generation for the whole select→mount operation
 * (docs/276-shared-package-cache-integrity section 5, "Ordering and cleanup").
 *
 * It used to be a 10-minute expiry, which is not a lease: a selection slower than the window lost
 * its protection while still holding nothing Docker could show, and the sweep then deleted a
 * lowerdir a starting container was about to mount. A claim now lives until its holder releases it,
 * which it does once the container exists — from then on `docker ps` is the liveness evidence.
 *
 * A claim is keyed by an opaque per-OPERATION token, not by the session: two creation attempts for
 * one session can overlap (a standby create the runner stopped waiting for, plus the cold-create
 * fallback), and a session key let the second attempt's release drop the first attempt's
 * protection while it was still mounting.
 *
 * Claims are taken and read under the scope's own lock (`withScopeLock`, `overlay-base.ts`), so a
 * sweep cannot interleave between a selection reading the pointer and its claim becoming visible.
 */

const claims = new Map<string, Set<string>>();

export function overlayBaseGenKey(scopeHash: string, generation: number): string {
  return `${scopeHash}/g${generation}`;
}

/** Mint one per select→mount operation, and release it in that operation's `finally`. */
export function newOverlayClaimToken(): string {
  return crypto.randomUUID();
}

export function claimOverlayBaseGeneration(
  scopeHash: string,
  generation: number,
  token: string,
): void {
  const key = overlayBaseGenKey(scopeHash, generation);
  const holders = claims.get(key) ?? new Set<string>();
  holders.add(token);
  claims.set(key, holders);
}

/**
 * Call once the operation's container exists, or the attempt failed — in a `finally`, so a throw
 * between selection and mount cannot leave a generation pinned for the life of the process.
 */
export function releaseOverlayBaseClaims(token: string): void {
  for (const [key, holders] of claims) {
    if (!holders.delete(token)) continue;
    if (holders.size === 0) claims.delete(key);
  }
}

export function liveOverlayBaseClaims(): string[] {
  return [...claims.keys()];
}

export function clearOverlayBaseClaims(): void {
  claims.clear();
}
