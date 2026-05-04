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

import type { AgentId } from "../../shared/types.js";
import type { SessionManager } from "../sessions.js";
import type { SessionContainerManager } from "../session-container.js";
import type { SessionRunnerRegistry, SessionRunnerInterface } from "../session-runner.js";
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

/** Subset of ContainerSessionRunner methods that recovery uses. */
interface RecoveryRunner extends SessionRunnerInterface {
  killAgentOnWorker?: (opts?: { timeoutMs?: number }) => Promise<void>;
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
  if (!deps.containerManager) {
    throw new ServiceError(503, "Container manager not available");
  }

  const runner = deps.runnerRegistry.get(sessionId) as RecoveryRunner | undefined;

  // Notify viewers BEFORE we tear down the runner — once disposed, the
  // emitMessage channel is gone.
  if (runner) {
    runner.emitMessage({
      type: "container_restarting",
      sessionId,
    });
  }

  // Best-effort: tell the worker to kill the agent. Don't block restart on
  // worker reachability — if the worker is dead, we still want to destroy
  // the container.
  if (runner?.killAgentOnWorker) {
    try {
      await runner.killAgentOnWorker({ timeoutMs: RECOVERY_WORKER_TIMEOUT_MS });
    } catch {
      /* worker may be dead — that's why we're restarting */
    }
  }

  // Force-dispose the runner. The runner's normal dispose() refuses while
  // the agent is "running" (defense in depth against transient WS
  // disconnects); for an explicit user-initiated recovery we override.
  deps.runnerRegistry.dispose(sessionId, { force: true });

  // Destroy the existing container if any. destroy() also clears any prior
  // create-error so the next attempt starts clean. Safe when no container.
  const existing = deps.containerManager.get(sessionId);
  const noContainer = !existing;
  if (existing) {
    await deps.containerManager.destroy(sessionId);
  } else {
    // No container, but a stale create-error from a previous failed attempt
    // would persist otherwise — wipe it so we observe only THIS attempt's
    // outcome below.
    deps.containerManager.clearCreateError(sessionId);
  }

  // Trigger the runner factory to create a fresh container. Previously the
  // design relied on the client's WS reconnect to call `activateSession` →
  // `getOrCreate` → factory. If the WS reconnect raced or the factory's
  // fire-and-forget creation block silently failed, the user was stuck on
  // "Restarting…" indefinitely (the symptom of bug 112-followup).
  //
  // By kicking off `getOrCreate` here we guarantee creation starts as part
  // of this HTTP call. We then wait briefly for the new container to either
  // reach "running" or surface a creation error, so the client gets an
  // informative response without having to wait for the next 10s poll.
  if (!session.workspaceDir) {
    throw new ServiceError(500, "Session has no workspaceDir — cannot create container");
  }
  deps.runnerRegistry.getOrCreate(sessionId, session.workspaceDir, deps.defaultAgentId);

  const deadline = Date.now() + RESTART_READY_TIMEOUT_MS;
  let newContainerState: RestartContainerResult["newContainerState"] = "pending";
  let error: string | null = null;
  while (Date.now() < deadline) {
    const sc = deps.containerManager.get(sessionId);
    if (sc?.status === "running") {
      newContainerState = "running";
      break;
    }
    const errRecord = deps.containerManager.getLastCreateError(sessionId);
    if (errRecord) {
      newContainerState = "missing";
      error = errRecord.error;
      break;
    }
    if (sc?.status === "starting") {
      newContainerState = "starting";
      // Don't break — keep polling for "running" until the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  // Final read so we don't miss a state transition that happened on the
  // last sleep before the deadline.
  if (newContainerState === "pending" || newContainerState === "starting") {
    const sc = deps.containerManager.get(sessionId);
    if (sc?.status === "running") {
      newContainerState = "running";
    } else if (sc?.status === "starting") {
      newContainerState = "starting";
    }
    const errRecord = deps.containerManager.getLastCreateError(sessionId);
    if (errRecord && newContainerState !== "running") {
      newContainerState = "missing";
      error = errRecord.error;
    }
  }

  return { ok: true, noContainer, newContainerState, error };
}
