/**
 * Container recovery services — kill agent, restart container.
 *
 * See docs/112-container-recovery/plan.md. These are the escalation
 * actions exposed via HTTP routes (not WS): the orchestrator owns
 * Docker, so restart works even when the worker is dead.
 *
 * Both operations are idempotent — safe to retry. They never throw on
 * "already gone" states; the goal is to reach the desired state, not to
 * report that the previous state was tidy.
 */

import type { AgentId, RescuePhase } from "../../shared/types.js";
import type { SessionManager } from "../sessions.js";
import type { SessionContainerManager } from "../session-container.js";
import type { SessionRunnerRegistry, SessionRunnerInterface } from "../session-runner.js";
import type { ServiceManager } from "../service-manager.js";
import type { SessionOomCircuitBreaker } from "../oom-circuit-breaker.js";
import { ServiceError } from "./types.js";

/** Short timeout for recovery-time worker calls — never block on a wedged worker. */
const RECOVERY_WORKER_TIMEOUT_MS = 3000;

/**
 * How long to wait inside `restartContainer` for the new container to
 * either reach "running" or surface a creation error. Kept short so the
 * HTTP request returns promptly — the poll loop on the client picks up
 * any further progress beyond this window.
 */
const RESTART_READY_TIMEOUT_MS = 8000;

/**
 * Per-phase max duration. On expiry we record the phase as failed and continue.
 *
 * Note: `creating_container`, `starting_stack`, and `restarting_agent` are
 * declared here for type-completeness (the `Record<…, number>` shape
 * enumerates every RescuePhase that *could* have a timeout) but aren't
 * used as a `withTimeout()` bound — the actual readiness wait happens in
 * `waitForContainerReady` with `RESTART_READY_TIMEOUT_MS`. Treat the
 * non-zero entries here as the active phase budgets; the zeroed ones are
 * placeholders so the Record type doesn't drift if we ever add a new
 * RescuePhase.
 */
const PHASE_TIMEOUT_MS: Record<Exclude<RescuePhase, "ready" | "failed">, number> = {
  stopping_stack: 10000,
  destroying_container: 8000,
  creating_container: 0, // see note above
  starting_stack: 0,      // see note above
  restarting_agent: 0,    // cosmetic — destroying_container + creating_container are the real work
};

/**
 * Hard ceiling for the orphan reaper. Without a bound a hung Docker
 * daemon (a documented production failure mode) wedges the rescue
 * indefinitely — which manifests as the client overlay stuck on the
 * first phase. We log and continue so the user always gets a fresh
 * runner attempt.
 */
const REAP_ORPHANS_TIMEOUT_MS = 10000;

/** Subset of ContainerSessionRunner methods that recovery uses. */
interface RecoveryRunner extends SessionRunnerInterface {
  killAgentOnWorker?: (opts?: { timeoutMs?: number }) => Promise<void>;
  serviceManager?: ServiceManager | null;
  /**
   * Lifecycle flag honored by the runner's `disposed` handler in
   * app-lifecycle.ts. Set by `restartAgent` before disposing so the
   * compose stack is preserved across the agent-container swap.
   * Absent on in-process SessionRunner (test mode) — undefined assignment
   * is harmless there.
   */
  preserveComposeOnDispose?: boolean;
}

export interface RecoveryDeps {
  sessionManager: SessionManager;
  containerManager: SessionContainerManager | null;
  runnerRegistry: SessionRunnerRegistry;
  /**
   * Default agent ID used to seed the new runner when restart triggers a
   * fresh `getOrCreate`. The real selection is per-WS-connection and gets
   * applied on the next reconnect; this is just so the factory has a
   * non-undefined value during the gap.
   */
  defaultAgentId: AgentId;
  /**
   * OOM circuit breaker. The "Rescue session" / agent-container-restart
   * endpoints are the explicit user-initiated opt-in path, so resetting
   * here lets the runner factory try again. Without the reset, the
   * breaker would refuse the very restart the user asked for.
   */
  oomBreaker?: SessionOomCircuitBreaker;
}

export interface KillAgentResult {
  /** Whether the kill request reached the worker. False if the worker was unreachable. */
  killed: boolean;
  /** True when no agent was running to begin with. */
  noop: boolean;
}

export interface RestartContainerResult {
  /** Always true — restart is idempotent. */
  ok: true;
  /** True when there was no container to destroy (still creates a fresh one on next attach). */
  noContainer: boolean;
  /**
   * Final container state observed within the readiness window:
   *  - "running"  — new container is up and the worker is healthy.
   *  - "starting" — fresh creation is in flight; client will see "running"
   *                 on a subsequent poll.
   *  - "missing"  — creation failed within the window; `error` is populated.
   *  - "pending"  — readiness window expired before status changed; the
   *                 client should keep polling.
   */
  newContainerState: "running" | "starting" | "missing" | "pending";
  /** Most recent creation error, when one was recorded during this restart. */
  error: string | null;
}

/**
 * Force-kill the agent process inside the session's worker. Sends
 * SIGKILL via the worker's `/agent/kill` endpoint; harmless if no agent
 * is currently running.
 *
 * Use this when `interrupt_agent` (SIGINT) didn't take. If the worker
 * itself is unreachable, returns `502` so the UI can advise restarting
 * the container instead.
 */
export async function killAgent(
  deps: RecoveryDeps,
  sessionId: string,
): Promise<KillAgentResult> {
  const session = deps.sessionManager.get(sessionId);
  if (!session) throw new ServiceError(404, "Session not found");

  const runner = deps.runnerRegistry.get(sessionId) as RecoveryRunner | undefined;
  if (!runner) {
    return { killed: false, noop: true };
  }

  // Mark the runner so the post-turn flow records this as user-initiated.
  runner.wasInterrupted = true;

  // Container runners expose killAgentOnWorker. In-process runners
  // (test mode) just have the agent reference directly.
  if (runner.killAgentOnWorker) {
    try {
      await runner.killAgentOnWorker({ timeoutMs: RECOVERY_WORKER_TIMEOUT_MS });
    } catch (err) {
      throw new ServiceError(
        502,
        `Worker unreachable — try Restart container. (${(err as Error).message})`,
      );
    }
  } else {
    // Direct runner — kill the local agent process.
    const agent = runner.getAgent();
    if (!agent) return { killed: false, noop: true };
    agent.kill();
    runner.setAgent(null);
  }

  // Notify all attached viewers via the buffered message stream.
  runner.emitMessage({ type: "agent_interrupted" });

  // Reset local running flag — the worker has acknowledged the kill, so
  // any "agent_done" event that would normally do this is no longer
  // guaranteed to arrive.
  runner.running = false;

  return { killed: true, noop: false };
}

/**
 * Restart the session's container. The flow is:
 *   1. Notify viewers (`container_restarting` message).
 *   2. Best-effort kill agent on worker.
 *   3. Force-dispose the runner.
 *   4. Destroy the container via the container manager.
 *
 * After step 4 the system is in the same state as "stale container
 * exists" — the existing runner factory in `app-lifecycle.ts` will
 * create a fresh container on the next session activation, which the
 * client triggers by reconnecting its WebSocket.
 *
 * This is intentionally idempotent: if the container is already gone,
 * the destroy step is a no-op and the next attach still creates a
 * fresh one.
 */
export async function restartContainer(
  deps: RecoveryDeps,
  sessionId: string,
): Promise<RestartContainerResult> {
  const session = deps.sessionManager.get(sessionId);
  if (!session) throw new ServiceError(404, "Session not found");

  // Rescue session is the explicit user opt-in to retry — clear the
  // breaker so the new container actually gets created. Without this,
  // the factory would see the trip flag and refuse to make a container
  // for the very restart the user just requested.
  deps.oomBreaker?.reset(sessionId);

  if (!deps.containerManager) {
    throw new ServiceError(503, "Container manager not available");
  }
  if (!session.workspaceDir) {
    throw new ServiceError(500, "Session has no workspaceDir — cannot create container");
  }

  const runner = deps.runnerRegistry.get(sessionId) as RecoveryRunner | undefined;

  // Phased progress goes via emitMessage so reconnecting viewers see it
  // through the turn-event log. Once we dispose the runner the channel is
  // gone, so we capture a small helper that no-ops post-disposal — phases
  // after destroy_container will not have a viewer until the new runner
  // attaches.
  const emit = (phase: RescuePhase, extra: { reason?: string; message?: string } = {}) => {
    runner?.emitMessage({
      type: "container_restarting",
      sessionId,
      phase,
      ...extra,
    });
  };

  // ---- Phase: stopping_stack ----
  emit("stopping_stack");
  if (runner?.serviceManager) {
    try {
      await withTimeout(runner.serviceManager.stop(), PHASE_TIMEOUT_MS.stopping_stack);
    } catch (err) {
      // Best-effort: log and continue. The orphan reaper after destroy is
      // the safety net.
      console.warn(`[rescue] stop compose stack failed for ${sessionId}:`, err);
    }
  }

  // Best-effort: tell the worker to kill the agent. Don't block restart on
  // worker reachability — if the worker is dead, we still want to destroy
  // the container. Surface the failure via session_status.lastInterruptError
  // so the client can render a non-blocking toast (the kill is best-effort
  // by design, but the user deserves *some* feedback).
  if (runner?.killAgentOnWorker) {
    try {
      await runner.killAgentOnWorker({ timeoutMs: RECOVERY_WORKER_TIMEOUT_MS });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      runner.emitMessage({
        type: "session_status",
        sessionId,
        running: runner.running,
        queueLength: runner.queueLength,
        lastInterruptError: `Could not kill the wedged agent before destroying the container: ${msg}`,
      });
    }
  }

  // Force-dispose the runner. The runner's normal dispose() refuses while
  // the agent is "running" (defense in depth against transient WS
  // disconnects); for an explicit user-initiated recovery we override.
  deps.runnerRegistry.dispose(sessionId, { force: true });

  // ---- Phase: destroying_container ----
  emit("destroying_container");
  const existing = deps.containerManager.get(sessionId);
  const noContainer = !existing;
  if (existing) {
    try {
      await withTimeout(deps.containerManager.destroy(sessionId), PHASE_TIMEOUT_MS.destroying_container);
    } catch (err) {
      console.warn(`[rescue] destroy container failed for ${sessionId}:`, err);
    }
  } else {
    // No container, but a stale create-error from a previous failed attempt
    // would persist otherwise — wipe it so we observe only THIS attempt's
    // outcome below.
    deps.containerManager.clearCreateError(sessionId);
  }

  // Defense-in-depth: even when destroy succeeds, a previously running
  // compose stack may have spawned children that aren't tracked by the new
  // runner. Reap them by label so the new ServiceManager.start() doesn't
  // collide with survivors. Hard-bounded — a hung Docker daemon (a
  // documented production failure mode) must NOT wedge the rescue here.
  try {
    await withTimeout(deps.containerManager.reapOrphans(sessionId), REAP_ORPHANS_TIMEOUT_MS);
  } catch (err) {
    console.warn(`[rescue] reap orphans failed/timed out for ${sessionId}:`, err);
  }

  // ---- Phase: creating_container ----
  emit("creating_container");
  deps.runnerRegistry.getOrCreate(sessionId, session.workspaceDir, deps.defaultAgentId);

  const { newContainerState, error } = await waitForContainerReady(
    deps.containerManager,
    sessionId,
    Date.now() + RESTART_READY_TIMEOUT_MS,
  );

  // ---- Phase: starting_stack / ready / failed ----
  // The new ServiceManager will start lazily on next viewer attach (driven
  // by the runner factory). We only emit `starting_stack` if we're in a
  // healthy enough state to expect it; otherwise jump straight to failed.
  // Re-resolve the runner since the registry created a fresh one above —
  // emitMessage on the new runner reaches reconnecting viewers via the
  // turn-event buffer.
  const newRunner = deps.runnerRegistry.get(sessionId) as RecoveryRunner | undefined;
  const finalEmit = (phase: RescuePhase, extra: { reason?: string; message?: string } = {}) => {
    newRunner?.emitMessage({
      type: "container_restarting",
      sessionId,
      phase,
      ...extra,
    });
  };
  if (newContainerState === "running") {
    finalEmit("starting_stack");
    finalEmit("ready");
  } else if (newContainerState === "starting" || newContainerState === "pending") {
    // Still in progress — the client keeps polling and we let the next
    // reconcile finalize. Don't emit `ready` prematurely.
    finalEmit("starting_stack");
  } else {
    finalEmit("failed", {
      reason: "create_failed",
      ...(error !== null ? { message: error } : {}),
    });
  }

  return { ok: true, noContainer, newContainerState, error };
}

/**
 * Restart the agent container WITHOUT touching the compose stack.
 *
 * Why this exists: today's `restartContainer` (Rescue session) tears down
 * the compose stack as collateral damage when all the user actually needed
 * was a fresh agent container. The compose stack is often expensive to
 * rebuild (dev server cold start, dependent service warm-up) and in
 * dogfood mode the compose service IS the inner orchestrator UI — Rescue
 * destroys the UI the user was just looking at.
 *
 * Flow:
 *   1. Best-effort kill the agent CLI on the worker.
 *   2. Mark `runner.preserveComposeOnDispose = true` so the runner's
 *      `disposed` lifecycle hook in app-lifecycle.ts leaves the
 *      ServiceManager alive in the per-app map.
 *   3. Force-dispose the runner.
 *   4. Destroy the agent container (NOT the compose containers — they
 *      carry `shipit-parent-session=<sid>` and we deliberately don't
 *      touch them).
 *   5. `runnerRegistry.getOrCreate(...)` to build a fresh runner; the
 *      factory's `setupServiceManager` adopts the orphaned manager
 *      instead of creating a new one (see `adoptExistingServiceManager`
 *      in app-lifecycle.ts).
 *
 * Idempotent: safe to retry. If the agent container is already gone, the
 * destroy step is a no-op and the next attach still creates a fresh one.
 * See docs/127-restart-agent for the full design.
 */
export async function restartAgent(
  deps: RecoveryDeps,
  sessionId: string,
): Promise<RestartContainerResult> {
  const session = deps.sessionManager.get(sessionId);
  if (!session) throw new ServiceError(404, "Session not found");

  // Same rationale as restartContainer — see comment there. The
  // agent-container restart is an explicit user retry so the breaker
  // should not gate it.
  deps.oomBreaker?.reset(sessionId);

  if (!deps.containerManager) {
    throw new ServiceError(503, "Container manager not available");
  }
  if (!session.workspaceDir) {
    throw new ServiceError(500, "Session has no workspaceDir — cannot create container");
  }

  const runner = deps.runnerRegistry.get(sessionId) as RecoveryRunner | undefined;

  // Emit single cosmetic phase via the runner's message stream. We use the
  // same `container_restarting` message type as Rescue session so the
  // client's existing overlay logic handles it; only the phase value
  // differs.
  const emit = (phase: RescuePhase, extra: { reason?: string; message?: string } = {}) => {
    runner?.emitMessage({
      type: "container_restarting",
      sessionId,
      phase,
      ...extra,
    });
  };

  emit("restarting_agent");

  // Best-effort: tell the worker to kill the agent CLI. Don't block on
  // worker reachability — if the worker is wedged we still want to
  // recreate the container. Surface the failure as a non-blocking toast
  // via session_status.lastInterruptError, same pattern as restartContainer.
  if (runner?.killAgentOnWorker) {
    try {
      await runner.killAgentOnWorker({ timeoutMs: RECOVERY_WORKER_TIMEOUT_MS });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      runner.emitMessage({
        type: "session_status",
        sessionId,
        running: runner.running,
        queueLength: runner.queueLength,
        lastInterruptError: `Could not kill the wedged agent before restarting: ${msg}`,
      });
    }
  }

  // ---- Mark for compose preservation, then force-dispose. ----
  // The runner's `disposed` event handler in app-lifecycle.ts reads
  // `preserveComposeOnDispose` and skips `mgr.stop()` when set, leaving
  // the ServiceManager in `serviceManagers` for the next runner to adopt.
  // (Field is optional on `RecoveryRunner` to allow in-process test
  // runners — the assignment is a no-op when the underlying object
  // doesn't have a real setter for it.)
  if (runner) runner.preserveComposeOnDispose = true;
  deps.runnerRegistry.dispose(sessionId, { force: true });

  // ---- Phase: destroying_container ----
  emit("destroying_container");
  const existing = deps.containerManager.get(sessionId);
  const noContainer = !existing;
  if (existing) {
    try {
      await withTimeout(
        deps.containerManager.destroy(sessionId),
        PHASE_TIMEOUT_MS.destroying_container,
      );
    } catch (err) {
      console.warn(`[restart-agent] destroy container failed for ${sessionId}:`, err);
    }
  } else {
    // No container, but a stale create-error from a previous failed attempt
    // would persist otherwise — wipe it so we observe only THIS attempt's
    // outcome below.
    deps.containerManager.clearCreateError(sessionId);
  }

  // NOTE: We deliberately skip `reapOrphans` here. Rescue session reaps
  // by `shipit-parent-session=<sid>` label, which would force-remove the
  // running compose containers — exactly what we're trying to preserve.

  // ---- Phase: creating_container ----
  emit("creating_container");
  deps.runnerRegistry.getOrCreate(sessionId, session.workspaceDir, deps.defaultAgentId);

  const { newContainerState, error } = await waitForContainerReady(
    deps.containerManager,
    sessionId,
    Date.now() + RESTART_READY_TIMEOUT_MS,
  );

  // Final phase. Re-resolve the runner — the registry created a fresh one
  // above, so we emit from the new runner so the next viewer attach picks
  // it up via the turn-event buffer.
  const newRunner = deps.runnerRegistry.get(sessionId) as RecoveryRunner | undefined;
  const finalEmit = (phase: RescuePhase, extra: { reason?: string; message?: string } = {}) => {
    newRunner?.emitMessage({
      type: "container_restarting",
      sessionId,
      phase,
      ...extra,
    });
  };
  if (newContainerState === "running") {
    finalEmit("ready");
  } else if (newContainerState === "starting" || newContainerState === "pending") {
    // Still in progress — client keeps polling and the next reconcile
    // finalizes. Don't emit `ready` prematurely.
  } else {
    finalEmit("failed", {
      reason: "create_failed",
      ...(error !== null ? { message: error } : {}),
    });
  }

  return { ok: true, noContainer, newContainerState, error };
}

/**
 * Poll the container manager for a fresh `getOrCreate`'d session until
 * one of:
 *   - status === "running"  → returns `{ newContainerState: "running" }`
 *   - getLastCreateError(...) populated → `{ newContainerState: "missing", error }`
 *   - deadline expires      → `"pending"` or `"starting"` per last seen state
 *
 * Polls every 250 ms with a final-read fallback to catch transitions that
 * landed during the last sleep. Shared between `restartContainer` and
 * `restartAgent` so both flows agree on what "ready" looks like.
 */
async function waitForContainerReady(
  containerManager: SessionContainerManager,
  sessionId: string,
  deadlineMs: number,
): Promise<{ newContainerState: RestartContainerResult["newContainerState"]; error: string | null }> {
  // Every populated-error branch returns directly with the specific
  // error string. The trailing "deadline expired" return below can
  // never have an error attached (we'd have returned from inside the
  // loop if there were one), so `error: null` is correct.
  let newContainerState: RestartContainerResult["newContainerState"] = "pending";
  while (Date.now() < deadlineMs) {
    const sc = containerManager.get(sessionId);
    if (sc?.status === "running") {
      return { newContainerState: "running", error: null };
    }
    const errRecord = containerManager.getLastCreateError(sessionId);
    if (errRecord) {
      return { newContainerState: "missing", error: errRecord.error };
    }
    if (sc?.status === "starting") {
      newContainerState = "starting";
      // Don't break — keep polling for "running" until the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  // Final read so we don't miss a state transition that happened on the
  // last sleep before the deadline.
  const sc = containerManager.get(sessionId);
  if (sc?.status === "running") {
    return { newContainerState: "running", error: null };
  }
  if (sc?.status === "starting") {
    newContainerState = "starting";
  }
  const errRecord = containerManager.getLastCreateError(sessionId);
  if (errRecord) {
    return { newContainerState: "missing", error: errRecord.error };
  }
  return { newContainerState, error: null };
}

/** Race a promise against a timeout; resolves with the promise's value or throws on timeout. */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  if (ms <= 0) return await p;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race<T | undefined>([
      p,
      new Promise<undefined>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
