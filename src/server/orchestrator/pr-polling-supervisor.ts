/**
 * PrPollingSupervisor — the single polling timer + per-repo cadence selection.
 *
 * Split out of `pr-status-poller.ts` (docs/201 Phase P9). There is one
 * supervisor for the whole poller, not one per repo. It wakes every fast tick,
 * checks the global gate, then for each tracked repo decides whether enough
 * time has elapsed under that repo's current cadence before issuing a GraphQL
 * poll (delegated back to the poller via the `pollRepo` callback).
 *
 * Cadence math and the constants below: see docs/064-pr-lifecycle-flow/plan.md
 * "Polling budget."
 */

import type { AutoFixManager } from "./auto-fix-manager.js";
import type { AutoMergeManager } from "./auto-merge-manager.js";
import type { PrSessionTracker } from "./pr-session-tracker.js";
import type { PollingGlobalGate } from "./polling-global-gate.js";

/**
 * Per-repo polling cadences. The poller picks an interval per repo on every
 * supervisor tick based on the "most expectant" tracked session — fast when
 * CI is mid-flight or a push just landed, slow when everything has settled.
 *
 * `PR_STATUS_POLL_INTERVAL_MS` is the fast bucket. It is also the supervisor
 * tick: the supervisor wakes every FAST_INTERVAL_MS, then per repo decides
 * whether the SLOW_INTERVAL has elapsed before issuing a GraphQL call.
 */
export const PR_STATUS_POLL_INTERVAL_MS = 15_000;
/** Slow bucket: settled repos (success state, no recent push, mergeable known). */
export const PR_STATUS_SLOW_INTERVAL_MS = 120_000;
/**
 * After a session's auto-push fires, that session's repo stays at fast
 * cadence for this long — that's how long it takes CI to register and
 * usually finish on small PRs. After this elapses (and nothing else holds
 * the session at fast), the repo drops back to slow.
 */
const POST_PUSH_FAST_WINDOW_MS = 5 * 60_000;

/** Issues a single GraphQL poll for one repo. Delegated back to the poller. */
type PollRepoFn = (repoKey: string, owner: string, repo: string) => Promise<void>;

export class PrPollingSupervisor {
  private readonly gate: PollingGlobalGate;
  private readonly tracker: PrSessionTracker;
  private readonly autoFix: AutoFixManager;
  private readonly autoMerge: AutoMergeManager;
  private readonly pollRepo: PollRepoFn;

  /**
   * Single supervisor timer (one for the whole poller, not one per repo). Wakes
   * every PR_STATUS_POLL_INTERVAL_MS, decides per repo whether enough time has
   * elapsed under its current cadence, then issues GraphQL calls for those
   * repos. `null` when the global gate is closed.
   */
  private timer: ReturnType<typeof setInterval> | null = null;
  /** repoKey (owner/repo) → timestamp when this repo last issued a GraphQL poll. */
  private lastPolledAt = new Map<string, number>();

  constructor(opts: {
    gate: PollingGlobalGate;
    tracker: PrSessionTracker;
    autoFix: AutoFixManager;
    autoMerge: AutoMergeManager;
    pollRepo: PollRepoFn;
  }) {
    this.gate = opts.gate;
    this.tracker = opts.tracker;
    this.autoFix = opts.autoFix;
    this.autoMerge = opts.autoMerge;
    this.pollRepo = opts.pollRepo;
  }

  // ---- Per-repo cadence ----
  //
  // For each tracked session on a repo, pick a per-session cadence based on
  // what we expect to change. The repo runs at the minimum (fastest) of its
  // tracked sessions' cadences. Fast = 15 s, slow = 120 s.

  private perSessionInterval(sessionId: string): number {
    // Autonomous action keep-alive: the loop needs prompt feedback.
    const fix = this.autoFix.get(sessionId);
    if (fix?.status === "running") return PR_STATUS_POLL_INTERVAL_MS;
    const merge = this.autoMerge.get(sessionId);
    if (merge?.enabled && merge.managed) return PR_STATUS_POLL_INTERVAL_MS;

    // Recent auto-push: CI is registering, fast cadence so the user (or the
    // auto-fix loop) sees the first non-none check promptly.
    const pushAt = this.tracker.lastAutoPushAt.get(sessionId);
    if (pushAt !== undefined && Date.now() - pushAt < POST_PUSH_FAST_WINDOW_MS) {
      return PR_STATUS_POLL_INTERVAL_MS;
    }

    const last = this.tracker.lastKnown.get(sessionId);
    if (!last) {
      // Haven't polled this session yet — fast so the first observation lands
      // quickly (the orchestrator usually pairs trackSession with a force).
      return PR_STATUS_POLL_INTERVAL_MS;
    }

    if (last.checks.state === "pending") return PR_STATUS_POLL_INTERVAL_MS;

    // mergeable: UNKNOWN means GitHub is still computing — poll fast until it
    // resolves. "none" + unknown is the no-CI case and should stay slow.
    if (last.mergeable === "unknown" && last.checks.state !== "none") {
      return PR_STATUS_POLL_INTERVAL_MS;
    }

    return PR_STATUS_SLOW_INTERVAL_MS;
  }

  private repoInterval(repoKey: string): number {
    let interval = PR_STATUS_SLOW_INTERVAL_MS;
    for (const [sessionId, key] of this.tracker.sessionRepos) {
      if (key !== repoKey) continue;
      if (this.tracker.mergedSessions.has(sessionId)) continue;
      const sessionInterval = this.perSessionInterval(sessionId);
      if (sessionInterval < interval) interval = sessionInterval;
      if (interval === PR_STATUS_POLL_INTERVAL_MS) break;
    }
    return interval;
  }

  // ---- Timer lifecycle ----

  /**
   * Arm the supervisor if it isn't running and the global gate is open. A
   * single supervisor handles every tracked repo — there is no per-repo
   * timer. The supervisor wakes every fast tick and decides per repo whether
   * the slow interval has elapsed before issuing a GraphQL call.
   */
  ensure(): void {
    if (this.timer) return;
    if (!this.gate.isOpen()) return;
    this.timer = setInterval(() => this.tick(), PR_STATUS_POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Record that a repo just issued a poll (cadence anchor). */
  recordPolledAt(repoKey: string): void {
    this.lastPolledAt.set(repoKey, Date.now());
  }

  /** Forget a repo's cadence anchor (no tracked sessions remain). */
  deleteRepoCadence(repoKey: string): void {
    this.lastPolledAt.delete(repoKey);
  }

  /** Stop the timer and clear all cadence anchors. */
  destroy(): void {
    this.stop();
    this.lastPolledAt.clear();
  }

  /**
   * Supervisor tick. Closes the gate if it should be closed; otherwise for
   * each tracked repo, polls iff the repo's per-repo interval has elapsed
   * since its last poll. Errors per repo are isolated so one repo's GraphQL
   * failure doesn't stop the others.
   */
  private tick(): void {
    if (!this.gate.isOpen()) {
      this.stop();
      return;
    }

    const now = Date.now();
    const repoKeysSeen = new Set<string>();
    for (const [sessionId, repoKey] of this.tracker.sessionRepos) {
      if (this.tracker.mergedSessions.has(sessionId)) continue;
      if (repoKeysSeen.has(repoKey)) continue;
      repoKeysSeen.add(repoKey);

      const interval = this.repoInterval(repoKey);
      const last = this.lastPolledAt.get(repoKey) ?? 0;
      if (now - last < interval) continue;

      const slash = repoKey.indexOf("/");
      if (slash <= 0) continue;
      const owner = repoKey.slice(0, slash);
      const repo = repoKey.slice(slash + 1);
      this.pollRepo(repoKey, owner, repo).catch((err: unknown) => {
        console.error(`[pr-poller] Error polling ${repoKey}:`, err);
      });
    }
  }
}
