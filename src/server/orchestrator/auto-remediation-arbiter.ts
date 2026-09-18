export const CLAIM_TTL_MS = 30 * 60 * 1000;

interface ArbiterEntry {
  owner?: string;
  claimedHeadSha?: string;
  claimedAt?: number;
  /** Pre-push SHA; suppress retries until a different head is observed. */
  actedHeadSha?: string;
}

export class RemediationArbiter {
  private entries = new Map<string, ArbiterEntry>();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  private entry(sessionId: string): ArbiterEntry {
    let e = this.entries.get(sessionId);
    if (!e) { e = {}; this.entries.set(sessionId, e); }
    return e;
  }

  private reapExpired(sessionId: string): void {
    const e = this.entries.get(sessionId);
    if (!e) return;
    if (e.owner === undefined || e.claimedAt === undefined) return;
    if (this.now() - e.claimedAt < CLAIM_TTL_MS) return;
    console.warn(
      `[remediation-arbiter] claim by "${e.owner}" for ${sessionId} exceeded the ` +
        `${CLAIM_TTL_MS}ms TTL — treating as abandoned and releasing`,
    );
    delete e.owner;
    delete e.claimedAt;
    delete e.claimedHeadSha;
    this.gc(sessionId, e);
  }

  shouldSuppress(sessionId: string, headSha: string): boolean {
    this.reapExpired(sessionId);
    const e = this.entries.get(sessionId);
    if (!e) return false;

    if (e.owner !== undefined) return true;

    if (e.actedHeadSha !== undefined) {
      if (headSha && headSha !== e.actedHeadSha) {
        delete e.actedHeadSha;
        this.gc(sessionId, e);
        return false;
      }
      return true;
    }
    return false;
  }

  claim(sessionId: string, headSha: string, owner: string): boolean {
    this.reapExpired(sessionId);
    const e = this.entry(sessionId);
    if (e.owner !== undefined && e.owner !== owner) return false;
    if (e.owner === owner) return true;
    if (e.actedHeadSha !== undefined && headSha === e.actedHeadSha) return false;
    e.owner = owner;
    e.claimedHeadSha = headSha;
    e.claimedAt = this.now();
    return true;
  }

  release(sessionId: string, owner: string, opts: { pushed: boolean }): void {
    const e = this.entries.get(sessionId);
    if (e?.owner !== owner) return;
    const acted = e.claimedHeadSha;
    delete e.owner;
    delete e.claimedHeadSha;
    delete e.claimedAt;
    if (opts.pushed && acted) {
      e.actedHeadSha = acted;
    } else {
      this.gc(sessionId, e);
    }
  }

  lastActedHeadSha(sessionId: string): string | undefined {
    return this.entries.get(sessionId)?.actedHeadSha;
  }

  delete(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  isClaimed(sessionId: string): boolean {
    this.reapExpired(sessionId);
    return this.entries.get(sessionId)?.owner !== undefined;
  }

  private gc(sessionId: string, e: ArbiterEntry): void {
    if (e.owner === undefined && e.claimedHeadSha === undefined && e.actedHeadSha === undefined) {
      this.entries.delete(sessionId);
    }
  }
}
