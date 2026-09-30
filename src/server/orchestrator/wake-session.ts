import type { SessionManager } from "./sessions.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import { prepareDispatch, withSettlement, type PreparedDispatch } from "./prepared-dispatch.js";
import { createTurnSettlement, type TurnHandle, type TurnOutcome } from "./turn-settlement.js";
import { toQueuedMessage } from "./session-runner.js";
import { readAnswerHold } from "./turn-admission.js";
import { holdTurn } from "./held-turns.js";
import { releaseQueuedTurn } from "./queue-drain.js";
import type { CredentialStore } from "./credential-store.js";
import type { ProviderAccountManager } from "./provider-account-manager.js";
import type { SessionContainerManager } from "./session-container.js";
import type { AgentId, SessionInfo, SessionMessageOrigin } from "../shared/types.js";
import { ContainerSessionRunner } from "./container-session-runner.js";
import { prepareSessionAgentEnvironment } from "./session-agent-env.js";
import { reconcileRunnerAgent } from "./reconcile-runner-agent.js";
import type { QueueHold } from "./services/recovery.js";

export interface WakeSessionDeps {
  sessionManager: SessionManager;
  runnerRegistry: SessionRunnerRegistry;
  defaultAgentId: AgentId;
  credentialsDir?: string | undefined;
  credentialStore?: CredentialStore | undefined;
  providerAccountManager?: ProviderAccountManager | undefined;
  containerManager?: SessionContainerManager | null | undefined;
  restoreWorkspace?: ((sessionId: string) => Promise<boolean>) | undefined;
}

export interface WakeTurnOptions {
  /** Include all context; the wake may run much later. */
  text: string;
  activity?: string;
  messageOrigin?: SessionMessageOrigin;
  onSettled?: (outcome: TurnOutcome) => void;
  /** Worker-persisted identity lets adoption restore settlement after restart. */
  deliveryId?: string;
  /**
   * The caller's hold on this runner, released just before the dispatch so the wake runs
   * ahead of the messages it kept queued (docs/321-agent-requested-restart).
   */
  releaseHold?: QueueHold;
}

// Dispatch also waits for readiness; this wait exposes early boot failures.
const WAKE_WORKER_READY_TIMEOUT_MS = 30_000;

/**
 * Resolves once the turn is dispatched, NOT once it runs. Read `admitted` on the handle:
 * a wake queued behind a running turn or a system hold has started nothing (docs/304).
 */
export async function wakeSessionWithTurn(
  deps: WakeSessionDeps,
  session: SessionInfo,
  opts: WakeTurnOptions,
): Promise<TurnHandle> {
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

  // docs/322 — nothing may run before the user replies, so nothing is booted to wait.
  if (readAnswerHold({ answerHold: sessionManager }, session.id)) {
    const settlement = createTurnSettlement();
    const entry = toQueuedMessage(withSettlement(wakeDispatch(session.id, opts), settlement));
    if (holdTurn(sessionManager, session.id, entry)) {
      settlement.noteAdmission("queued");
      console.log(`[wake-session] held a wake for ${session.id} until the user answers`);
      // No wake runs ahead of what the caller's hold kept queued, so that can go now.
      if (opts.releaseHold) {
        opts.releaseHold.release();
        releaseQueuedTurn(opts.releaseHold.runner);
      }
      return settlement;
    }
  }

  // Recreate reclaimed workspaces before booting a container against them.
  if (deps.restoreWorkspace) await deps.restoreWorkspace(session.id);

  if (containerManager) {
    const stale = runnerRegistry.get(session.id);
    const sc = containerManager.get(session.id);
    const live = !!sc && (sc.status === "running" || sc.status === "starting");
    // A create still in preflight has no container record yet; it is not stale.
    if (stale && !live && !stale.awaitingContainer) runnerRegistry.dispose(session.id, { force: true });
  }

  const runner = runnerRegistry.getOrCreate(
    session.id,
    session.workspaceDir,
    session.agentId ?? defaultAgentId,
  );

  // getOrCreate does not update an existing runner's agent selection.
  const effectiveAgentId = reconcileRunnerAgent(runner, session.agentId);

  // Avoid changing a live turn's credentials; its queued successor prepares its own.
  if (!runner.running && credentialsDir && credentialStore) {
    await prepareSessionAgentEnvironment(runner, {
      sessionId: session.id,
      agentId: effectiveAgentId,
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

  opts.releaseHold?.release();

  return runner.dispatch(wakeDispatch(session.id, opts));
}

function wakeDispatch(sessionId: string, opts: WakeTurnOptions): PreparedDispatch {
  // The callback preserves synchronous settlement; awaiting the handle adds a microtask.
  const onSettled = opts.onSettled;
  return prepareDispatch({
    text: opts.text,
    agentInterface: undefined,
    messageOrigin: opts.messageOrigin,
    activity: opts.activity,
    systemTurn: true,
    automatic: true,
    heldId: undefined,
    ...(onSettled
      ? {
          onTurnComplete: (outcome: TurnOutcome) => {
            try {
              onSettled(outcome);
            } catch (err) {
              console.error(`[wake-session] settlement handler for ${sessionId} threw:`, err);
            }
          },
        }
      : { onTurnComplete: undefined }),
    deliveryId: opts.deliveryId,
    dictated: undefined,
    resetMergedBranch: undefined,
    compactContext: undefined,
    silent: undefined,
    execution: undefined,
    images: undefined,
    files: undefined,
    uploads: undefined,
    permissionMode: undefined,
    postTurn: undefined,
  });
}
