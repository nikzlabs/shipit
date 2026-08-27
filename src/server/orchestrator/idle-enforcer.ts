import type { SessionContainerManager } from "./session-container.js";
import type { SessionRunnerRegistry, SessionRunnerInterface } from "./session-runner.js";
import type { DockerMemoryStats } from "../shared/types.js";
import type { LogSource } from "../shared/types.js";
import { bytesOverBudget } from "./memory-pressure.js";
import { getErrorMessage } from "./validation.js";
import type { SessionManager } from "./sessions.js";
import { holdsActiveReservation } from "./sessions.js";

// ---- Idle container enforcement ----

/**
 * docs/284 — the hooks the enforcer needs to reclaim a session's Compose stack
 * *separately* from its agent container. Optional: without them (local mode,
 * unit tests) tier 1 degrades to today's full teardown and tier 2 is inert.
 */
export interface IdleServiceHooks {
  /** Sessions that currently have a live Compose stack. */
  liveSessions: () => string[];
  /** Whether this session has a live Compose stack right now. */
  has: (sessionId: string) => boolean;
  /** Stop the stack and drop its manager. Fire-and-forget. */
  stop: (sessionId: string) => void;
}

/** Dependencies for idle container enforcement. */
export interface IdleEnforcementDeps {
  containerManager: SessionContainerManager | null;
  runnerRegistry: SessionRunnerRegistry;
  /** Reservation source of truth. Reserved sessions are never eviction candidates. */
  sessionManager?: SessionManager;
  /**
   * Returns the most recent Docker memory snapshot, or `null` when stats
   * aren't available yet.
   *
   * docs/284 — this is now the ONLY thing that triggers reclaim. The
   * `maxIdleContainers` count it used to override was removed: a count treated
   * an idle shell and a Postgres service as equal claims on the machine, when
   * what the user is rationing is memory (req 3). With no stats there is
   * nothing to reclaim *against*, so the enforcer does nothing and says so —
   * there is deliberately no count to fall back to.
   */
  getMemoryStats?: () => DockerMemoryStats | null;
  /** docs/284 — lets tier 1 keep a session's preview alive past its agent container. */
  services?: IdleServiceHooks;
  /**
   * Optional broadcast hook. When provided, the enforcer fires a
   * `session_status` SSE event with `reason: "agent-reclaimed"` (tier 1) or
   * `"memory-pressure"` (tier 2) before tearing down the runner. The
   * orchestrator uses this to surface the pause in the client — without it,
   * the user sees `containerState: missing` in the health strip with no
   * explanation. See docs/124-session-rescue-and-diagnostics §1.6.
   */
  sseBroadcast?: (event: string, data: unknown) => void;
  /**
   * Optional per-session log hook. Mirrors the `session_status` SSE event
   * into the per-session Logs ring buffer so a viewer that reconnects
   * later still sees why their container went away.
   */
  broadcastLog?: (sessionId: string, source: LogSource, text: string) => void;
}

/**
 * A session the enforcer may reclaim.
 *
 * docs/284 replaced the old fixed grace period (10 minutes, during which a
 * runner was exempt outright) with this ordering. The window existed to
 * protect a transient WebSocket disconnect — a page reload, a network blip —
 * from costing the user a container start, and ordering gives that protection
 * without the cost the veto carried: reclaim now runs ONLY when ShipIt is over
 * its memory budget, and refusing to touch a recently-detached session in that
 * state would mean refusing to free memory the host needs. Longest-idle first
 * means the just-detached session is reached last, and only if everything
 * older failed to cover the shortfall — which is what the window was really
 * saying. Under real pressure the old code bypassed the window entirely, so
 * nothing is protected here that was protected before.
 */
interface Candidate {
  sessionId: string;
  runner: SessionRunnerInterface | undefined;
  /** Smaller = idle for longer. 0 for "never had a viewer" / no runner. */
  idleSince: number;
}

/**
 * Create the `enforceIdleContainerLimit` function.
 *
 * docs/284 — ShipIt reclaims idle sessions when, and only when, it is over the
 * user's memory budget, and it does so in two tiers so the cheapest loss goes
 * first:
 *
 *  - **Tier 1** stops the longest-idle session's *agent container* and leaves
 *    its Compose stack running, whole (req 1, req 7). Every idle session goes
 *    through tier 1 before any tier 2 happens, which is what maximises the
 *    number of previews that survive.
 *  - **Tier 2** stops the surviving stacks, longest-idle first, once tier 1 has
 *    been exhausted and usage is still over budget.
 *
 * Important invariants (unchanged):
 *  - Never disposes a runner that is busy (`runner.agentBusy` — a running turn,
 *    pending background work, or an in-flight sub-agent consult).
 *  - Never disposes a runner with an attached viewer.
 *  - Never touches a session holding an always-on reservation (docs/241).
 *  - Runner disposal is TOCTOU-safe: state is re-checked at dispose time, and
 *    `runner.dispose()` itself refuses to run while the agent is active.
 *  - The container is destroyed only AFTER the runner accepted disposal
 *    (planning#298). A declined dispose leaves the container running, so the
 *    runner-level guards and the enforcer can never disagree about whether the
 *    session is reclaimable.
 *
 * This function MUST NOT be called synchronously from a WebSocket close
 * handler. WebSocket lifecycle is independent from runner/container
 * lifecycle. Schedule via the periodic timer instead.
 */
export function createIdleEnforcer(
  enforceDeps: IdleEnforcementDeps,
): () => void {
  const {
    containerManager, runnerRegistry, sessionManager, getMemoryStats,
    services, sseBroadcast, broadcastLog,
  } = enforceDeps;

  /**
   * When each session's agent container was reclaimed by tier 1. Tier 2 orders
   * by this, because a preview-only session has no runner left to carry
   * `lastViewerDetachAt`. A stack this process never tier-1'd (it survived an
   * orchestrator restart) sorts as oldest, which is correct — it has been idle
   * since before we started.
   */
  const tier1At = new Map<string, number>();
  /**
   * The snapshot the last reclaiming pass acted on. Two triggers can fire
   * between two polls — the 30s timer and the edge-triggered pressure
   * crossing — and the second would read the same pre-reclaim `usedBytes` and
   * stop another session for memory the first one had already given back.
   * Identity is the exact test: the poller replaces the holder's value with a
   * new object on every read, so a snapshot we have already acted on is
   * literally the same object.
   */
  let actedOn: DockerMemoryStats | null = null;

  /** Shared guards: is this session reclaimable at all right now? */
  function isReclaimable(sessionId: string, runner: SessionRunnerInterface | undefined): boolean {
    // docs/241 — the reservation is a user-facing always-on guarantee, so it
    // wins over reclaim. `holdsActiveReservation`, not the raw flag: an
    // archived row that still carries the flag is ignored by admission, so
    // protecting its surviving container here would hold RAM for a reservation
    // the books no longer count.
    if (holdsActiveReservation(sessionManager?.get(sessionId))) return false;
    if (!runner) return true;
    // docs/235 — `agentBusy`, not `running`. `running` is only ever set by an
    // orchestrator-initiated turn, so a session whose agent woke ITSELF (a
    // background task finished and the CLI started a fresh turn) reads as
    // idle here and gets its container destroyed mid-turn. `agentBusy` also
    // covers the quieter case: a task still pending between turns, which is
    // work that will resume and must not be reclaimed — and (planning#298) a
    // backgrounded sub-agent consult, which has neither a running turn nor a
    // resident streaming process yet is very much live work.
    if (runner.agentBusy) return false;
    if (runner.viewerCount > 0) return false;
    return true;
  }

  /** Longest-idle first. See {@link Candidate}. */
  function byReclaimOrder(a: Candidate, b: Candidate): number {
    return a.idleSince - b.idleSince;
  }

  return () => {
    if (!containerManager) return;

    const stats = getMemoryStats?.() ?? null;
    let need = bytesOverBudget(stats);
    if (need <= 0) return;

    if (stats && stats === actedOn) return;

    const now = Date.now();

    const usage = stats?.bySession ?? {};
    let reclaimedSomething = false;
    /**
     * Set when a reclaim freed an unknown amount, which means the shortfall we
     * are still carrying is stale. Tier 2 must not run on it: tier 1 has just
     * preserved a preview precisely so it can survive, and spending the same
     * unadjusted `need` on tier 2 would stop that stack in the same pass —
     * turning "keep the preview" back into today's full teardown.
     */
    let shortfallIsStale = false;

    // ---- Tier 1: stop agent containers, keep the previews running ----
    const tier1: Candidate[] = [];
    for (const sc of containerManager.getAll()) {
      if (containerManager.isStandby(sc.sessionId)) continue;
      const runner = runnerRegistry.get(sc.sessionId);
      if (!isReclaimable(sc.sessionId, runner)) continue;
      tier1.push({ sessionId: sc.sessionId, runner, idleSince: runner?.lastViewerDetachAt ?? 0 });
    }
    tier1.sort(byReclaimOrder);

    for (const c of tier1) {
      if (need <= 0) break;
      // TOCTOU re-check: between the scan and now, the runner may have become
      // active (new viewer attached, agent started). Dispose only if it is
      // still safe. `runner.dispose()` also enforces this at the runner level
      // (defense in depth).
      const runner = runnerRegistry.get(c.sessionId);
      if (!isReclaimable(c.sessionId, runner)) continue;

      // Keep the stack only when there IS one — otherwise `preserveCompose`
      // would strand an empty ServiceManager in the map forever.
      const keepsPreview = !!services?.has(c.sessionId);
      if (keepsPreview && runner) {
        (runner as SessionRunnerInterface & { preserveComposeOnDispose?: boolean })
          .preserveComposeOnDispose = true;
      }

      // planning#298 — dispose FIRST, and treat a declined dispose as "leave
      // this container alone". Previously `destroy` was fired unconditionally
      // and `dispose` ran after it, so the runner-level guards could only
      // decline *after* `container.stop` was already issued: the work died
      // anyway, and the surviving runner was left pointed at a dead container.
      runnerRegistry.dispose(c.sessionId);
      if (runner && !runner.disposed) {
        console.log(
          `[idle-cleanup] Skipping container destroy for session ${c.sessionId}`
          + ` — runner declined disposal (still holds live work)`,
        );
        // Do not leave a stale preserve flag on a runner that stayed alive: the
        // next, unrelated dispose would silently skip its compose teardown.
        if (keepsPreview && runner) {
          (runner as SessionRunnerInterface & { preserveComposeOnDispose?: boolean })
            .preserveComposeOnDispose = false;
        }
        continue;
      }

      const measured = usage[c.sessionId];
      const freed = measured?.agentBytes ?? 0;
      need -= freed;
      reclaimedSomething = true;
      if (keepsPreview) tier1At.set(c.sessionId, now);
      const idleMs = c.idleSince > 0 ? Math.max(0, now - c.idleSince) : undefined;
      console.log(
        `[idle-cleanup] Stopping agent container for session ${c.sessionId}`
        + ` (over budget, freed≈${Math.round(freed / 1024 / 1024)}MB,`
        + ` preview=${keepsPreview ? "kept" : "none"}`
        + `${idleMs !== undefined ? ` idleMs=${idleMs}` : ""})`,
      );
      announce(c.sessionId, keepsPreview ? "agent-reclaimed" : "memory-pressure", idleMs, runner?.queueLength ?? 0);
      destroyContainer(c.sessionId);
      // Nothing measured this session, so we cannot tell how much of the
      // shortfall it just covered. Stop here and let the next snapshot decide:
      // subtracting 0 and carrying on would walk the whole idle list and empty
      // the machine over an overage one container may already have settled.
      if (!measured) { shortfallIsStale = true; break; }
    }

    // ---- Tier 2: stop the surviving preview stacks ----
    if (need > 0 && !shortfallIsStale && services) {
      const tier2: Candidate[] = [];
      for (const sessionId of services.liveSessions()) {
        const runner = runnerRegistry.get(sessionId);
        // A stack whose session is still in use is not idle slack. Its agent
        // container was either just reclaimed above (no runner) or never
        // existed; either way the reclaimability guards still apply.
        if (!isReclaimable(sessionId, runner)) continue;
        if (runner) continue; // still has a live runner — tier 1 declined it
        tier2.push({ sessionId, runner: undefined, idleSince: tier1At.get(sessionId) ?? 0 });
      }
      tier2.sort(byReclaimOrder);

      for (const c of tier2) {
        if (need <= 0) break;
        if (!isReclaimable(c.sessionId, runnerRegistry.get(c.sessionId))) continue;
        const measured = usage[c.sessionId];
        const freed = measured?.serviceBytes ?? 0;
        need -= freed;
        reclaimedSomething = true;
        tier1At.delete(c.sessionId);
        console.log(
          `[idle-cleanup] Stopping preview services for session ${c.sessionId}`
          + ` (still over budget, freed≈${Math.round(freed / 1024 / 1024)}MB)`,
        );
        announce(c.sessionId, "memory-pressure", undefined, 0);
        services.stop(c.sessionId);
        if (!measured) break; // same reasoning as tier 1
      }
    }

    if (reclaimedSomething) actedOn = stats;
    else {
      // Over budget with nothing reclaimable is req 11's case: warn, never
      // refuse. The banner is already up; this line is the server-side record.
      console.log(
        `[idle-cleanup] Over memory budget by ≈${Math.round(need / 1024 / 1024)}MB`
        + ` with nothing idle to reclaim — every session is in use`,
      );
    }
  };

  /**
   * Surface the reclaim to the user before tearing down. Without this, the
   * user comes back to a tab that just shows `containerState: missing` with no
   * explanation. The SSE event is delivered via the global event channel; the
   * runner-attached emitMessage path is unavailable because the runner is
   * already disposed. The per-session Logs ring gets a copy so a future
   * reconnect / diagnostics dump still has the record.
   * See docs/124-session-rescue-and-diagnostics §1.6.
   */
  function announce(
    sessionId: string,
    reason: "agent-reclaimed" | "memory-pressure",
    idleMs: number | undefined,
    queueLength: number,
  ): void {
    if (sseBroadcast) {
      sseBroadcast("session_status", {
        type: "session_status",
        sessionId,
        running: false,
        queueLength,
        reason,
        ...(idleMs !== undefined ? { idleMs } : {}),
      });
    }
    if (broadcastLog) {
      const human = reason === "agent-reclaimed"
        ? `Agent container stopped to stay inside ShipIt's memory budget (workspace preserved). `
          + `The preview is still running. Send a message to resume — a fresh container starts automatically.`
        : `Session container and preview services stopped to reclaim memory (workspace preserved). `
          + `Send a message to resume — a fresh container starts automatically.`;
      broadcastLog(sessionId, "server", human);
    }
  }

  function destroyContainer(sessionId: string): void {
    containerManager?.destroy(sessionId).catch((err: unknown) => {
      const errMsg = getErrorMessage(err);
      console.error(`[idle-cleanup] Failed to destroy container ${sessionId}:`, errMsg);
      // The runner was already disposed above — its emitMessage path is gone —
      // so the only durable way to surface this is the per-session log ring.
      if (broadcastLog) {
        broadcastLog(
          sessionId,
          "server",
          `Failed to destroy idle container: ${errMsg}. Container may still be running on the host.`,
        );
      }
    });
  }
}
