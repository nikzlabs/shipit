import type { SessionRunnerRegistry } from "./session-runner.js";
import type { AutoFixManager } from "./auto-fix-manager.js";
import type { AutoMergeManager } from "./auto-merge-manager.js";
import type { AutoConflictResolveManager } from "./auto-conflict-resolve-manager.js";
import type { PrSessionTracker } from "./pr-session-tracker.js";

// Bridge brief viewer disconnects; this timer does not control container cleanup.
const VIEWER_DETACH_GRACE_MS = 60_000;

export class PollingGlobalGate {
  private readonly runnerRegistry?: SessionRunnerRegistry;
  private readonly tracker: PrSessionTracker;
  private readonly autoFix: AutoFixManager;
  private readonly autoMerge: AutoMergeManager;
  private readonly autoConflictResolve?: AutoConflictResolveManager;
  private readonly hasPendingMergeWatch?: () => boolean;
  private lastViewerDetachAt = 0;

  constructor(opts: {
    runnerRegistry?: SessionRunnerRegistry;
    tracker: PrSessionTracker;
    autoFix: AutoFixManager;
    autoMerge: AutoMergeManager;
    autoConflictResolve?: AutoConflictResolveManager;
    hasPendingMergeWatch?: () => boolean;
  }) {
    this.runnerRegistry = opts.runnerRegistry;
    this.tracker = opts.tracker;
    this.autoFix = opts.autoFix;
    this.autoMerge = opts.autoMerge;
    this.autoConflictResolve = opts.autoConflictResolve;
    this.hasPendingMergeWatch = opts.hasPendingMergeWatch;
  }

  private anyViewersConnected(): boolean {
    const registry = this.runnerRegistry;
    if (!registry) return true;
    for (const id of registry.ids()) {
      const r = registry.get(id);
      if (r && r.viewerCount > 0) return true;
    }
    return false;
  }

  private anyAutonomousActionInFlight(): boolean {
    // A viewerless merge watch can only fire if the poller observes the merge.
    if (this.hasPendingMergeWatch?.()) return true;

    for (const sessionId of this.tracker.sessionRepos.keys()) {
      if (this.tracker.mergedSessions.has(sessionId)) continue;

      const fix = this.autoFix.get(sessionId);
      if (fix?.status === "running") return true;
      // Armed remediation needs polls to discover the failure that starts it.
      if (fix?.status !== "exhausted" && this.autoFix.isEnabledFor(sessionId)) return true;

      const resolve = this.autoConflictResolve?.get(sessionId);
      if (resolve?.status === "running") return true;
      if (
        this.autoConflictResolve
        && resolve?.status !== "exhausted"
        && this.autoConflictResolve.isEnabledFor(sessionId)
      ) {
        return true;
      }

      const merge = this.autoMerge.get(sessionId);
      // Native GitHub auto-merge does not need ShipIt's poller.
      if (merge?.enabled && merge.managed) return true;

      const runner = this.runnerRegistry?.get(sessionId);
      if (runner?.running && runner.viewerCount === 0) return true;
    }
    return false;
  }

  isOpen(): boolean {
    if (this.anyViewersConnected()) return true;
    if (this.anyAutonomousActionInFlight()) return true;
    if (
      this.lastViewerDetachAt > 0
      && Date.now() - this.lastViewerDetachAt < VIEWER_DETACH_GRACE_MS
    ) {
      return true;
    }
    return false;
  }

  clearDetachGrace(): void {
    this.lastViewerDetachAt = 0;
  }

  armDetachGrace(): void {
    if (this.anyViewersConnected()) return;
    if (this.lastViewerDetachAt === 0) this.lastViewerDetachAt = Date.now();
  }
}
