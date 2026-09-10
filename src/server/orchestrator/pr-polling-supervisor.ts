import type { AutoFixManager } from "./auto-fix-manager.js";
import type { AutoMergeManager } from "./auto-merge-manager.js";
import type { PrSessionTracker } from "./pr-session-tracker.js";
import type { PollingGlobalGate } from "./polling-global-gate.js";

export const PR_STATUS_POLL_INTERVAL_MS = 15_000;
export const PR_STATUS_SLOW_INTERVAL_MS = 120_000;
const POST_PUSH_FAST_WINDOW_MS = 5 * 60_000;

type PollRepoFn = (repoKey: string, owner: string, repo: string) => Promise<void>;

export class PrPollingSupervisor {
  private readonly gate: PollingGlobalGate;
  private readonly tracker: PrSessionTracker;
  private readonly autoFix: AutoFixManager;
  private readonly autoMerge: AutoMergeManager;
  private readonly pollRepo: PollRepoFn;

  private timer: ReturnType<typeof setInterval> | null = null;
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

  private perSessionInterval(sessionId: string): number {
    const fix = this.autoFix.get(sessionId);
    if (fix?.status === "running") return PR_STATUS_POLL_INTERVAL_MS;
    const merge = this.autoMerge.get(sessionId);
    if (merge?.enabled && merge.managed) return PR_STATUS_POLL_INTERVAL_MS;

    const pushAt = this.tracker.lastAutoPushAt.get(sessionId);
    if (pushAt !== undefined && Date.now() - pushAt < POST_PUSH_FAST_WINDOW_MS) {
      return PR_STATUS_POLL_INTERVAL_MS;
    }

    const last = this.tracker.lastKnown.get(sessionId);
    if (!last) {
      return PR_STATUS_POLL_INTERVAL_MS;
    }

    if (last.checks.state === "pending") return PR_STATUS_POLL_INTERVAL_MS;

    // Unknown mergeability without CI stays slow.
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

  recordPolledAt(repoKey: string): void {
    this.lastPolledAt.set(repoKey, Date.now());
  }

  deleteRepoCadence(repoKey: string): void {
    this.lastPolledAt.delete(repoKey);
  }

  destroy(): void {
    this.stop();
    this.lastPolledAt.clear();
  }

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
