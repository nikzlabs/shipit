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

import type { SessionManager } from "../sessions.js";
import type { SessionContainerManager } from "../session-container.js";
import type { SessionRunnerRegistry, SessionRunnerInterface } from "../session-runner.js";
import { ServiceError } from "./types.js";

/** Short timeout for recovery-time worker calls — never block on a wedged worker. */
const RECOVERY_WORKER_TIMEOUT_MS = 3000;

/** Subset of ContainerSessionRunner methods that recovery uses. */
interface RecoveryRunner extends SessionRunnerInterface {
  killAgentOnWorker?: (opts?: { timeoutMs?: number }) => Promise<void>;
}

export interface RecoveryDeps {
  sessionManager: SessionManager;
  containerManager: SessionContainerManager | null;
  runnerRegistry: SessionRunnerRegistry;
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
}

/**
 * Force-kill the agent process inside the session's worker. Sends
 * SIGKILL via the worker's `/agent/kill` endpoint; harmless if no agent
 * is currently running.
 *
 * Use this when `interrupt_claude` (SIGINT) didn't take. If the worker
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
  runner.emitMessage({ type: "claude_interrupted" });

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

  // Destroy the container. The destroy() call swallows "container already
  // gone" errors internally, so this is safe even if the container has
  // already exited.
  const sc = deps.containerManager.get(sessionId);
  if (!sc) {
    return { ok: true, noContainer: true };
  }
  await deps.containerManager.destroy(sessionId);
  return { ok: true, noContainer: false };
}
