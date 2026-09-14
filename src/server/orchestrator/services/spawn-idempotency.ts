// A spawn whose response is lost looks identical to one that never arrived, so the
// caller's retry would spawn a second session. Keyed claims collapse the retry onto
// the first spawn. docs/306-spawn-retry-safety.

const DEFAULT_TTL_MS = 10 * 60 * 1000;

interface Claim<T> {
  result: Promise<T>;
  claimedAt: number;
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
    const result = spawn();
    this.claims.set(key, { result, claimedAt: this.now() });
    try {
      return { result: await result, deduplicated: false };
    } catch (err) {
      // A failed spawn must not be replayed as a failure: the retry is a real retry.
      this.claims.delete(key);
      throw err;
    }
  }

  private evictExpired(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, claim] of this.claims) {
      if (claim.claimedAt <= cutoff) this.claims.delete(key);
    }
  }

  get size(): number {
    return this.claims.size;
  }
}
