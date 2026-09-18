// A spawn whose response is lost looks identical to one that never arrived, so the
// caller's retry would spawn a second session. Keyed claims collapse the retry onto
// the first spawn. docs/306-spawn-retry-safety.

const DEFAULT_TTL_MS = 10 * 60 * 1000;

interface Claim<T> {
  result: Promise<T>;
  claimedAt: number;
  settled: boolean;
}

export interface SpawnClaimsOptions {
  ttlMs?: number;
  now?: () => number;
}

export class SpawnClaims<T> {
  private readonly claims = new Map<string, Claim<T>>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: SpawnClaimsOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  // Registers the claim synchronously, before awaiting: a check-then-act gap would let
  // two concurrent requests with one key both spawn.
  async run(key: string, spawn: () => Promise<T>): Promise<{ result: T; deduplicated: boolean }> {
    this.evictExpired();
    const existing = this.claims.get(key);
    if (existing) {
      return { result: await existing.result, deduplicated: true };
    }
    const claim: Claim<T> = { result: spawn(), claimedAt: this.now(), settled: false };
    this.claims.set(key, claim);
    try {
      const result = await claim.result;
      claim.settled = true;
      return { result, deduplicated: false };
    } catch (err) {
      claim.settled = true;
      // A failed spawn must not be replayed as a failure: the retry is a real retry.
      // Only ever withdraw our OWN claim — a slow spawn that failed after being evicted
      // would otherwise delete the entry a later, successful spawn had registered.
      if (this.claims.get(key) === claim) this.claims.delete(key);
      throw err;
    }
  }

  // A pending spawn is never evicted: dropping it would let a second spawn start under
  // the same key while the first is still running, which is the duplicate this prevents.
  private evictExpired(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, claim] of this.claims) {
      if (claim.settled && claim.claimedAt <= cutoff) this.claims.delete(key);
    }
  }

  get size(): number {
    return this.claims.size;
  }
}
