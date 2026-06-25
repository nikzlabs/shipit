/**
 * PollingGlobalGate — the viewer + in-flight-action gate for the PR poller.
 *
 * Split out of `pr-status-poller.ts` (docs/201 Phase P9). The supervisor only
 * runs while this gate is open; when it closes, zero GraphQL polls fire until
 * a viewer comes back or an autonomous flow kicks in.
 *
 * The gate is open when ANY of these is true:
 *   - a browser viewer is attached to any runner;
 *   - we're inside the disconnect grace window after the last viewer left;
 *   - an autonomous action is in flight or armed on any tracked session
 *     (auto-fix or auto-resolve-conflicts enabled and not yet exhausted,
 *     ShipIt-managed auto-merge enabled, or a viewerless runner that's mid-turn
 *     — the headless flow). Auto-fix and auto-resolve both count while merely
 *     *armed* (not just while running) so a viewerless session can detect and
 *     remediate a CI failure or a merge conflict that lands after the browser
 *     closes — otherwise the loop could never fire headlessly;
 *   - any session carries a pending notify-on-merge watch (docs/196): the watch
 *     fires only when the child PR's terminal state is *observed by a poll*, so
 *     a viewerless child waiting on a human merge needs the supervisor alive to
 *     ever wake its parent.
 * When all are false, the supervisor is stopped.
 *
 * This decision is intentionally distinct from the per-repo cadence decision
 * (which lives in the supervisor): the gate decides whether polling runs at
 * all; the cadence decides how often. See docs/064-pr-lifecycle-flow/plan.md
 * "Polling budget."
 */

import type { SessionRunnerRegistry } from "./session-runner.js";
import type { AutoFixManager } from "./auto-fix-manager.js";
import type { AutoMergeManager } from "./auto-merge-manager.js";
import type { AutoConflictResolveManager } from "./auto-conflict-resolve-manager.js";
import type { PrSessionTracker } from "./pr-session-tracker.js";

/**
 * After the last viewer detaches, keep polling for this long before pausing.
 * Tolerates page reloads and short network blips so a quick reconnect doesn't
 * pay the cost of a re-burn. Aligned with the idle-enforcer's grace window
 * (see `idle-enforcer.ts:IDLE_GRACE_PERIOD_MS`) so both timers fire on the
 * same schedule from the user's perspective.
 */
const VIEWER_DETACH_GRACE_MS = 60_000;

export class PollingGlobalGate {
  private readonly runnerRegistry?: SessionRunnerRegistry;
  private readonly tracker: PrSessionTracker;
  private readonly autoFix: AutoFixManager;
  private readonly autoMerge: AutoMergeManager;
  /**
   * Optional — undefined in the degraded setups that skip wiring it (no runner
   * registry; see `pr-status-poller.ts`). When present, an armed auto-resolve
   * loop keeps the gate open exactly like auto-fix.
   */
  private readonly autoConflictResolve?: AutoConflictResolveManager;
  /**
   * Optional — returns true when at least one session carries a non-terminal
   * notify-on-merge watch (docs/196). Lets the supervisor stay alive for a
   * viewerless child whose human merge would otherwise never be observed.
   */
  private readonly hasPendingMergeWatch?: () => boolean;

  /**
   * Timestamp when the last viewer detached. `0` means "currently has viewers
   * attached, or no viewer has ever been seen." Used to keep the supervisor
   * running through brief reconnects (within VIEWER_DETACH_GRACE_MS).
   */
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

  /**
   * True when at least one runner in the registry has a viewer attached.
   *
   * When no registry is wired (legacy callers, lightweight tests that don't
   * exercise the gate) treat the gate as always open so behavior matches the
   * pre-viewer-gating era. Production always wires the registry.
   */
  private anyViewersConnected(): boolean {
    const registry = this.runnerRegistry;
    if (!registry) return true;
    for (const id of registry.ids()) {
      const r = registry.get(id);
      if (r && r.viewerCount > 0) return true;
    }
    return false;
  }

  /**
   * True when an autonomous action that depends on PR/CI status updates is in
   * flight or armed: an armed auto-fix loop (enabled, budget not exhausted), a
   * managed auto-merge, or a headless agent turn (running runner with no viewer
   * — e.g. a child session spawned from chat).
   */
  private anyAutonomousActionInFlight(): boolean {
    // A pending notify-on-merge watch keeps the supervisor alive globally: the
    // watch is keyed on the CHILD session and fires only when that child's PR
    // terminal state is observed by a poll. A child waiting on a human merge
    // has no viewer and no armed remediation of its own, so without this the
    // poll stops and the parent's wake-turn never fires. Cheap (a single DB
    // read of the rare merge-watch rows) and only reached when no viewer is
    // attached, since `isOpen` short-circuits on `anyViewersConnected` first.
    if (this.hasPendingMergeWatch?.()) return true;

    for (const sessionId of this.tracker.sessionRepos.keys()) {
      if (this.tracker.mergedSessions.has(sessionId)) continue;

      const fix = this.autoFix.get(sessionId);
      if (fix?.status === "running") return true;
      // Auto-fix doesn't need a viewer to do its job — if it's armed (the
      // global setting is on and this session isn't paused), keep polling so a
      // CI failure is detected and fired even with no browser attached. Gating
      // only on `status === "running"` (above) is a chicken-and-egg: a
      // viewerless session can never reach "running" because the poll that
      // would fire the loop is itself viewer-gated. Stop once the per-head
      // budget is exhausted — nothing fires again until a new head lands, which
      // arrives with a viewer reattach or a headless turn (both gated below).
      if (fix?.status !== "exhausted" && this.autoFix.isEnabledFor(sessionId)) return true;

      // Auto-resolve-conflicts is the exact same shape as auto-fix (docs/146):
      // an armed, poller-driven remediation. It was missing here, so a
      // viewerless session with a merge conflict and auto-resolve enabled
      // never got polled — the conflict was never observed and the rebase
      // never fired. Same armed-vs-running chicken-and-egg, same fix.
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
      // ShipIt-managed auto-merge needs the poller to detect CI-success → merge.
      // Native auto-merge runs on GitHub's side and doesn't need our polling.
      if (merge?.enabled && merge.managed) return true;

      const runner = this.runnerRegistry?.get(sessionId);
      if (runner?.running && runner.viewerCount === 0) return true;
    }
    return false;
  }

  /**
   * The global gate. True when the supervisor should keep running.
   */
  isOpen(): boolean {
    if (this.anyViewersConnected()) return true;
    if (this.anyAutonomousActionInFlight()) return true;
    // No viewers, no autonomous action — but maybe we're inside the
    // disconnect grace window (a viewer just left and may reconnect).
    if (
      this.lastViewerDetachAt > 0
      && Date.now() - this.lastViewerDetachAt < VIEWER_DETACH_GRACE_MS
    ) {
      return true;
    }
    return false;
  }

  /**
   * A viewer attached (or a strong user-activity signal landed): clear the
   * disconnect grace timer so the supervisor stays running.
   */
  clearDetachGrace(): void {
    this.lastViewerDetachAt = 0;
  }

  /**
   * The last viewer detached. If no autonomous action is keeping the gate
   * open, arm the grace timer; the supervisor pauses itself on the next tick
   * after VIEWER_DETACH_GRACE_MS elapses without a reconnect.
   */
  armDetachGrace(): void {
    if (this.anyViewersConnected()) return;
    if (this.lastViewerDetachAt === 0) this.lastViewerDetachAt = Date.now();
  }
}
