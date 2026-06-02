/**
 * RemediationArbiter — cross-automation mutual exclusion for PR remediation.
 * (docs/169 Workstream C)
 *
 * The user requirement: two auto-changes must not act on the same head, and
 * once one acts and pushes, the other stays suppressed until fresh code (a new
 * head SHA) lands. This is the logical layer ABOVE the per-runner `running`
 * turn-level gate (which already prevents two agent turns at once) — it
 * coordinates the auto-fix-CI and auto-resolve-conflicts state machines so they
 * don't both decide to act on the same PR head.
 *
 * Two guarantees:
 *
 *  1. **Mutual exclusion.** At most one claim per session. A second automation's
 *     `claim()` returns false while a claim is held; the caller defers. The
 *     claim is released on EVERY terminal path of the attempt (success, error,
 *     deferred, exhausted, timeout) — see the "liveness" requirement in the
 *     plan; a claim that never releases would wedge every automation for the
 *     session.
 *
 *  2. **Await-fresh-signal after a push.** When a claim's attempt force-pushes
 *     / pushes (so the head SHA will change), the arbiter records the head that
 *     was acted on and suppresses ALL automations for that session until the
 *     poller next observes a DIFFERENT head SHA — i.e. GitHub has recomputed CI
 *     status and mergeability for the new code. This keys off head SHA and
 *     composes with each manager's existing reset-on-push logic rather than
 *     duplicating it. A non-pushing attempt (an errored or deferred outcome)
 *     does NOT arm suppression, so a manager's own same-head retry budget is
 *     untouched.
 *
 * Single-threaded JS makes `claim()` atomic, so the first of two same-tick
 * claimants wins and the second defers — no lock needed.
 */

interface ArbiterEntry {
  /** Current claim holder ("auto-resolve" / "auto-fix"), if any. */
  owner?: string;
  /** Head SHA the current claim is acting on. */
  claimedHeadSha?: string;
  /**
   * Head SHA of the last attempt that pushed. While the observed head still
   * equals this, ALL automations are suppressed (GitHub hasn't recomputed yet).
   * Cleared the first time a different head SHA is observed.
   */
  actedHeadSha?: string;
}

export class RemediationArbiter {
  private entries = new Map<string, ArbiterEntry>();

  private entry(sessionId: string): ArbiterEntry {
    let e = this.entries.get(sessionId);
    if (!e) { e = {}; this.entries.set(sessionId, e); }
    return e;
  }

  /**
   * True when an automation must NOT act on `headSha` right now, because either
   * another automation holds the claim OR a prior push acted on this exact head
   * and GitHub hasn't surfaced fresh code yet.
   *
   * Observing a head SHA different from `actedHeadSha` is the "fresh signal":
   * it lifts the post-push suppression (and is the natural place to clear it,
   * since the poller calls this with the freshly-observed head every transition).
   */
  shouldSuppress(sessionId: string, headSha: string): boolean {
    const e = this.entries.get(sessionId);
    if (!e) return false;

    // Mutual exclusion: a claim is held by some automation.
    if (e.owner !== undefined) return true;

    // Await-fresh-signal: a push acted on this exact head; suppress until a
    // different head is observed.
    if (e.actedHeadSha !== undefined) {
      if (headSha && headSha !== e.actedHeadSha) {
        // Fresh code landed — lift suppression.
        delete e.actedHeadSha;
        this.gc(sessionId, e);
        return false;
      }
      return true;
    }
    return false;
  }

  /**
   * Claim the per-session slot for `owner` acting on `headSha`. Returns false
   * when another automation already holds the claim (caller defers) or when a
   * prior push is still awaiting a fresh signal on this head.
   */
  claim(sessionId: string, headSha: string, owner: string): boolean {
    const e = this.entry(sessionId);
    if (e.owner !== undefined && e.owner !== owner) return false;
    // Re-entrant claim by the same owner is a no-op success (a multi-turn
    // attempt takes one logical claim).
    if (e.owner === owner) return true;
    // Don't let a fresh claim slip in on a head still awaiting a fresh signal.
    if (e.actedHeadSha !== undefined && headSha === e.actedHeadSha) return false;
    e.owner = owner;
    e.claimedHeadSha = headSha;
    return true;
  }

  /**
   * Release the claim held by `owner`. `pushed` records whether the attempt
   * pushed (head SHA will change): when true, the arbiter arms await-fresh-
   * signal on the claimed head so no automation re-fires until GitHub surfaces
   * the new code. A non-pushing outcome leaves the same-head budget untouched.
   *
   * Releasing a claim not held by `owner` is a safe no-op (defensive against
   * double-release).
   */
  release(sessionId: string, owner: string, opts: { pushed: boolean }): void {
    const e = this.entries.get(sessionId);
    if (!e || e.owner !== owner) return;
    const acted = e.claimedHeadSha;
    delete e.owner;
    delete e.claimedHeadSha;
    if (opts.pushed && acted) {
      e.actedHeadSha = acted;
    } else {
      this.gc(sessionId, e);
    }
  }

  /** The head SHA the last push acted on (Workstream C3 — stale-signal guard). */
  lastActedHeadSha(sessionId: string): string | undefined {
    return this.entries.get(sessionId)?.actedHeadSha;
  }

  /** Drop all arbiter state for a session (untrack / terminal PR). */
  delete(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  /** True when a remediation claim is currently held (cheap precondition for auto-merge). */
  isClaimed(sessionId: string): boolean {
    return this.entries.get(sessionId)?.owner !== undefined;
  }

  /** Drop an entry once it carries no live state, to keep the map from growing. */
  private gc(sessionId: string, e: ArbiterEntry): void {
    if (e.owner === undefined && e.claimedHeadSha === undefined && e.actedHeadSha === undefined) {
      this.entries.delete(sessionId);
    }
  }
}
