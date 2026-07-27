/**
 * Waking an idle session with a queued system turn.
 *
 * Several orchestrator-side events need to push an *actionable* turn into a
 * session that isn't currently being driven by a viewer: a watched child's PR
 * merges (docs/196), a cohort peer pushes a report (docs/233). They all face the
 * same three problems, which this module solves once:
 *
 *   1. **A stale runner.** A runner can outlive its container (idle-eviction
 *      race, missed Docker `die`, external `docker rm`). Dispatching into it
 *      silently fails, so it's torn down first and re-created — which boots a
 *      fresh container via the registry factory.
 *   2. **Cold credentials.** A resumed container has no agent credentials, a
 *      possibly-rotated OAuth token, and no MCP env, so the first turn would
 *      401. `prepareSessionAgentEnvironment` is idempotent and runs before the
 *      dispatch (skipped while a turn is already running — we must not race a
 *      live turn's environment).
 *   3. **A phantom ack.** The wake is only real once a live worker holds it; a
 *      boot failure disposes the runner, which we surface as a thrown error
 *      rather than reporting a turn that will never run.
 *
 * `runner.dispatch` is the only mutation: when the session is mid-turn it
 * ENQUEUES (drained post-turn, never preempting a running agent — the "poller
 * events must not kill running agents" invariant); when idle it starts the turn.
 */

import type { SessionManager } from "./sessions.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import type { CredentialStore } from "./credential-store.js";
import type { ProviderAccountManager } from "./provider-account-manager.js";
import type { SessionContainerManager } from "./session-container.js";
import type { AgentId, SessionInfo } from "../shared/types.js";
import { ContainerSessionRunner } from "./container-session-runner.js";
import { prepareSessionAgentEnvironment } from "./session-agent-env.js";

/** Collaborators the wake needs — all orchestrator-side. */
export interface WakeSessionDeps {
  sessionManager: SessionManager;
  runnerRegistry: SessionRunnerRegistry;
  defaultAgentId: AgentId;
  credentialsDir?: string | undefined;
  credentialStore?: CredentialStore | undefined;
  providerAccountManager?: ProviderAccountManager | undefined;
  containerManager?: SessionContainerManager | null | undefined;
}

export interface WakeTurnOptions {
  /** The self-describing prompt. Must carry every fact — it may run much later. */
  text: string;
  /** Activity label shown while the woken turn runs. */
  activity?: string;
  /**
   * Fires only once the turn has actually RUN to completion (wired through
   * `onTurnComplete`, which `dispatch` honors on both the idle path — it starts
   * the turn now — and the busy path, where the callback rides the in-memory
   * queue and fires when the enqueued turn later drains).
   */
  onExecuted?: () => void;
}

/**
 * How long to wait for a freshly-booted container's worker before dispatching
 * anyway. The dispatched turn's own startup also awaits readiness, so a slow
 * boot isn't a lost turn; the wait only makes a boot *failure* observable here.
 */
const WAKE_WORKER_READY_TIMEOUT_MS = 30_000;

/**
 * Enqueue a self-describing system turn into `session`, resuming its container
 * first if it has been idle-reaped. Throws when the session has no workspace or
 * its container could not be resumed — callers treat that as "not delivered"
 * and retry (or record it) rather than assuming the turn will run.
 */
export async function wakeSessionWithTurn(
  deps: WakeSessionDeps,
  session: SessionInfo,
  opts: WakeTurnOptions,
): Promise<void> {
  if (!session.workspaceDir) {
    throw new Error(`session ${session.id} has no workspace`);
  }
  const {
    sessionManager,
    runnerRegistry,
    containerManager,
    credentialsDir,
    credentialStore,
    providerAccountManager,
    defaultAgentId,
  } = deps;

  // A runner lingering in the registry whose container has been reaped points at
  // a dead worker — dispatching into it silently fails. Tear it down so the
  // `getOrCreate` below boots a fresh container.
  if (containerManager) {
    const stale = runnerRegistry.get(session.id);
    const sc = containerManager.get(session.id);
    const live = !!sc && (sc.status === "running" || sc.status === "starting");
    if (stale && !live) runnerRegistry.dispose(session.id, { force: true });
  }

  const runner = runnerRegistry.getOrCreate(
    session.id,
    session.workspaceDir,
    session.agentId ?? defaultAgentId,
  );

  // Refresh credentials/OAuth/MCP before the turn fires (idempotent). Skipped
  // while the agent is already running — the next-starting turn's env-prep
  // covers it, and we must not race a live turn's environment.
  if (!runner.running && credentialsDir && credentialStore) {
    await prepareSessionAgentEnvironment(runner, {
      sessionId: session.id,
      agentId: runner.agentId,
      deps: {
        credentialsDir,
        credentialStore,
        sessionManager,
        ...(providerAccountManager ? { providerAccountManager } : {}),
      },
    });
  }

  if (runner instanceof ContainerSessionRunner) {
    await Promise.race([
      runner.whenWorkerReady(),
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, WAKE_WORKER_READY_TIMEOUT_MS);
        t.unref?.();
      }),
    ]);
  }
  if (runner.disposed) {
    throw new Error(`session ${session.id} container could not be resumed; wake-turn not delivered`);
  }

  runner.dispatch({
    text: opts.text,
    ...(opts.activity ? { activity: opts.activity } : {}),
    systemTurn: true,
    ...(opts.onExecuted ? { onTurnComplete: () => opts.onExecuted!() } : {}),
  });
}
