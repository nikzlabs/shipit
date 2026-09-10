// Protect generations between spec creation and a running container's visible mount.
// Expire instead of releasing at start: a concurrent sweep may have an older Docker snapshot.
export const OVERLAY_BASE_CLAIM_MS = 10 * 60_000;

const claims = new Map<string, number>();

export function overlayBaseGenKey(scopeHash: string, generation: number): string {
  return `${scopeHash}/g${generation}`;
}

export function claimOverlayBaseGeneration(scopeHash: string, generation: number): void {
  claims.set(overlayBaseGenKey(scopeHash, generation), Date.now() + OVERLAY_BASE_CLAIM_MS);
}

export function liveOverlayBaseClaims(): string[] {
  const now = Date.now();
  for (const [key, expiry] of claims) {
    if (expiry <= now) claims.delete(key);
  }
  return [...claims.keys()];
}

export function clearOverlayBaseClaims(): void {
  claims.clear();
}
