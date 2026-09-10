import type { AgentId, RescuePhase } from "../../shared/types.js";
import type { SessionManager } from "../sessions.js";
import type { SessionContainerManager } from "../session-container.js";
import type { SessionRunnerRegistry, SessionRunnerInterface } from "../session-runner.js";
import type { ServiceManager } from "../service-manager.js";
import type { SessionOomCircuitBreaker } from "../oom-circuit-breaker.js";
import type { SessionLoopDetector } from "../loop-detector.js";
import { ServiceError } from "./types.js";
import { scheduleInterruptCommit, type PostInterruptCommitDeps } from "./post-interrupt-commit.js";

const RECOVERY_WORKER_TIMEOUT_MS = 3000;
const RESTART_READY_TIMEOUT_MS = 8000;

// Zero entries use the readiness wait instead of a phase timeout.
const PHASE_TIMEOUT_MS: Record<Exclude<RescuePhase, "ready" | "failed">, number> = {
  stopping_stack: 10000,
  destroying_container: 8000,
  creating_container: 0,
  starting_stack: 0,
  restarting_agent: 0,
};

const REAP_ORPHANS_TIMEOUT_MS = 10000;

interface RecoveryRunner extends SessionRunnerInterface {
  killAgentOnWorker?: (opts?: { timeoutMs?: number }) => Promise<void>;
  serviceManager?: ServiceManager | null;
  preserveComposeOnDispose?: boolean;
}

export interface RecoveryDeps {
  sessionManager: SessionManager;
  containerManager: SessionContainerManager | null;
  runnerRegistry: SessionRunnerRegistry;
  defaultAgentId: AgentId;
  oomBreaker?: SessionOomCircuitBreaker;
  loopDetector?: SessionLoopDetector;
  postInterruptCommitDeps?: PostInterruptCommitDeps;
  sseBroadcast?: (event: string, data: unknown) => void;
}

export interface KillAgentResult {
  killed: boolean;
  noop: boolean;
}

export interface RestartContainerResult {
  ok: true;
  noContainer: boolean;
  newContainerState: "running" | "starting" | "missing" | "pending";
  error: string | null;
}

export async function killAgent(
  deps: RecoveryDeps,
  sessionId: string,
): Promise<KillAgentResult> {
  const session = deps.sessionManager.get(sessionId);
  if (!session) throw new ServiceError(404, "Session not found");

  const runner: RecoveryRunner | undefined = deps.runnerRegistry.get(sessionId);
  if (!runner) {
    return { killed: false, noop: true };
  }

  runner.wasInterrupted = true;

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
    const agent = runner.getAgent();
    if (!agent) return { killed: false, noop: true };
    agent.kill();
    runner.setAgent(null);
  }

  runner.emitMessage({ type: "agent_interrupted" });

  // Worker acknowledgement does not guarantee a later agent_done event.
  runner.running = false;

  if (deps.postInterruptCommitDeps) {
    scheduleInterruptCommit({ deps: deps.postInterruptCommitDeps, runner });
  }

  return { killed: true, noop: false };
}

export interface RestartContainerOpts {
  /** False for settings-driven rebuilds; only Rescue grants another OOM retry. */
  resetBreakers?: boolean;
  /** Quick Capture can resolve an agent before persisting it in the session. */
  agentSeed?: AgentId;
}

// Old viewers remain on disposed runners; only global SSE reaches them all.
function announceRunnerReplaced(
  deps: Pick<RecoveryDeps, "sseBroadcast" | "runnerRegistry">,
  sessionId: string,
): void {
  deps.sseBroadcast?.("runner_replaced", {
    sessionId,
    incarnation: deps.runnerRegistry.incarnation(sessionId),
  });
}

export async function restartContainer(
  deps: RecoveryDeps,
  sessionId: string,
  opts: RestartContainerOpts = {},
): Promise<RestartContainerResult> {
  const session = deps.sessionManager.get(sessionId);
  if (!session) throw new ServiceError(404, "Session not found");

  // The loop detector can trip the breaker again unless its own window is cleared.
  if (opts.resetBreakers !== false) {
    deps.oomBreaker?.reset(sessionId);
    deps.loopDetector?.forget(sessionId);
  }

  if (!deps.containerManager) {
    throw new ServiceError(503, "Container manager not available");
  }
  if (!session.workspaceDir) {
    throw new ServiceError(500, "Session has no workspaceDir — cannot create container");
  }

  const runner: RecoveryRunner | undefined = deps.runnerRegistry.get(sessionId);

  const emit = (phase: RescuePhase, extra: { reason?: string; message?: string } = {}) => {
    runner?.emitMessage({
      type: "container_restarting",
      sessionId,
      phase,
      ...extra,
    });
  };

  emit("stopping_stack");
  if (runner?.serviceManager) {
    try {
      await withTimeout(runner.serviceManager.stop(), PHASE_TIMEOUT_MS.stopping_stack);
    } catch (err) {
      console.warn(`[rescue] stop compose stack failed for ${sessionId}:`, err);
    }
  }

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

  deps.runnerRegistry.dispose(sessionId, { force: true });

  emit("destroying_container");
  const existing = deps.containerManager.get(sessionId);
  const noContainer = !existing;
  if (existing) {
    try {
      await withTimeout(
        // Preview origins remain valid across the immediate replacement.
        deps.containerManager.destroy(sessionId, { replacementFollows: true }),
        PHASE_TIMEOUT_MS.destroying_container,
      );
    } catch (err) {
      console.warn(`[rescue] destroy container failed for ${sessionId}:`, err);
    }
  } else {
    // A create still in preflight has no record; destroy must cancel it too.
    try {
      await withTimeout(
        deps.containerManager.destroy(sessionId, { replacementFollows: true }),
        PHASE_TIMEOUT_MS.destroying_container,
      );
    } catch (err) {
      console.warn(`[rescue] cancelling an in-flight create failed for ${sessionId}:`, err);
    }
    deps.containerManager.clearCreateError(sessionId);
  }

  // Remove untracked Compose children before the replacement starts its stack.
  try {
    await withTimeout(deps.containerManager.reapOrphans(sessionId), REAP_ORPHANS_TIMEOUT_MS);
  } catch (err) {
    console.warn(`[rescue] reap orphans failed/timed out for ${sessionId}:`, err);
  }

  emit("creating_container");
  deps.runnerRegistry.getOrCreate(
    sessionId,
    session.workspaceDir,
    opts.agentSeed ?? session.agentId ?? deps.defaultAgentId,
  );

  announceRunnerReplaced(deps, sessionId);

  const { newContainerState, error } = await waitForContainerReady(
    deps.containerManager,
    sessionId,
    Date.now() + RESTART_READY_TIMEOUT_MS,
  );

  const newRunner: RecoveryRunner | undefined = deps.runnerRegistry.get(sessionId);
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
    finalEmit("starting_stack");
  } else {
    finalEmit("failed", {
      reason: "create_failed",
      ...(error !== null ? { message: error } : {}),
    });
  }

  return { ok: true, noContainer, newContainerState, error };
}

export async function restartAgent(
  deps: RecoveryDeps,
  sessionId: string,
): Promise<RestartContainerResult> {
  const session = deps.sessionManager.get(sessionId);
  if (!session) throw new ServiceError(404, "Session not found");

  deps.oomBreaker?.reset(sessionId);
  deps.loopDetector?.forget(sessionId);

  if (!deps.containerManager) {
    throw new ServiceError(503, "Container manager not available");
  }
  if (!session.workspaceDir) {
    throw new ServiceError(500, "Session has no workspaceDir — cannot create container");
  }

  const runner: RecoveryRunner | undefined = deps.runnerRegistry.get(sessionId);

  const emit = (phase: RescuePhase, extra: { reason?: string; message?: string } = {}) => {
    runner?.emitMessage({
      type: "container_restarting",
      sessionId,
      phase,
      ...extra,
    });
  };

  emit("restarting_agent");

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

  // The disposed handler leaves the ServiceManager alive for the replacement to adopt.
  if (runner) runner.preserveComposeOnDispose = true;
  deps.runnerRegistry.dispose(sessionId, { force: true });

  emit("destroying_container");
  const existing = deps.containerManager.get(sessionId);
  const noContainer = !existing;
  if (existing) {
    try {
      await withTimeout(
        deps.containerManager.destroyAgentContainer(sessionId),
        PHASE_TIMEOUT_MS.destroying_container,
      );
    } catch (err) {
      console.warn(`[restart-agent] destroy container failed for ${sessionId}:`, err);
    }
  } else {
    // Cancel an unpublished create while preserving Compose containers.
    try {
      await withTimeout(
        deps.containerManager.destroyAgentContainer(sessionId),
        PHASE_TIMEOUT_MS.destroying_container,
      );
    } catch (err) {
      console.warn(`[restart-agent] cancelling an in-flight create failed for ${sessionId}:`, err);
    }
    deps.containerManager.clearCreateError(sessionId);
  }

  // reapOrphans would remove the Compose containers this restart preserves.
  emit("creating_container");
  deps.runnerRegistry.getOrCreate(sessionId, session.workspaceDir, session.agentId ?? deps.defaultAgentId);

  const { newContainerState, error } = await waitForContainerReady(
    deps.containerManager,
    sessionId,
    Date.now() + RESTART_READY_TIMEOUT_MS,
  );

  const newRunner: RecoveryRunner | undefined = deps.runnerRegistry.get(sessionId);
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
    // The client keeps polling until the replacement is ready.
  } else {
    finalEmit("failed", {
      reason: "create_failed",
      ...(error !== null ? { message: error } : {}),
    });
  }

  return { ok: true, noContainer, newContainerState, error };
}

async function waitForContainerReady(
  containerManager: SessionContainerManager,
  sessionId: string,
  deadlineMs: number,
): Promise<{ newContainerState: RestartContainerResult["newContainerState"]; error: string | null }> {
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
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  // Include transitions during the final sleep.
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
