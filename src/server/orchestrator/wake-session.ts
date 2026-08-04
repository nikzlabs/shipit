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
import { prepareDispatch } from "./prepared-dispatch.js";
import type { TurnOutcome } from "./turn-settlement.js";
import type { CredentialStore } from "./credential-store.js";
import type { ProviderAccountManager } from "./provider-account-manager.js";
import type { SessionContainerManager } from "./session-container.js";
import type { AgentId, SessionInfo, SessionMessageOrigin } from "../shared/types.js";
import { ContainerSessionRunner } from "./container-session-runner.js";
import { prepareSessionAgentEnvironment } from "./session-agent-env.js";
import { reconcileRunnerAgent } from "./reconcile-runner-agent.js";

/** Collaborators the wake needs — all orchestrator-side. */
export interface WakeSessionDeps {
  sessionManager: SessionManager;
  runnerRegistry: SessionRunnerRegistry;
  defaultAgentId: AgentId;
  credentialsDir?: string | undefined;
  credentialStore?: CredentialStore | undefined;
  providerAccountManager?: ProviderAccountManager | undefined;
  containerManager?: SessionContainerManager | null | undefined;
  /**
   * docs/239 — re-materialize an evicted session's checkout before the wake
   * turn runs (`restoreSessionWorkspace`, already de-duped and a fast no-op when
   * the checkout is present).
   *
   * A watch can sit armed for the whole span of human review, which is long
   * enough for the disk-reclaim tiers to evict the workspace. Restoring at
   * delivery is strictly better than exempting a pending watch from reclaim,
   * which would hold disk for that unbounded duration. Optional — a setup
   * without it simply skips the restore, which is the pre-docs/239 behavior for
   * docs/196 too (this closes the same latent gap for it).
   */
  restoreWorkspace?: ((sessionId: string) => Promise<boolean>) | undefined;
}

export interface WakeTurnOptions {
  /** The self-describing prompt. Must carry every fact — it may run much later. */
  text: string;
  /** Activity label shown while the woken turn runs. */
  activity?: string;
  /** Another session's agent supplied this wake prompt. */
  messageOrigin?: SessionMessageOrigin;
  /**
   * Fires once the wake-turn reaches a TERMINAL outcome — on both the idle path
   * (the turn starts now) and the busy path (the settlement rides the in-memory
   * queue and resolves when the enqueued turn later drains and runs).
   *
   * docs/240 — the outcome is passed through rather than discarded. The previous
   * `onExecuted(): void` shape threw away the `errored` case, so a consumer
   * concluded "delivered" for a turn that crashed, never ran (`no-result`), or
   * was dropped when the queue was cleared. `TurnOutcome.status === "completed"`
   * is the only success; everything else means the wake did not land and the
   * caller should treat it as a failed attempt.
   */
  onSettled?: (outcome: TurnOutcome) => void;
  /**
   * SHI-264 — durable identity for this delivery, stamped onto the turn and
   * carried all the way to the worker.
   *
   * `onSettled` is an in-memory callback: it dies with the orchestrator process,
   * which is precisely why a restart mid-wake used to leave the originating
   * watch non-terminal and let a second wake queue behind the still-running
   * first one. The id survives — the worker reports it back from
   * `/agent/status`, so turn adoption can re-acquire the settlement and the
   * caller's reconcile can ask ground truth instead of a set it remembered to
   * update. Optional: a wake with no owning delivery (a docs/233 report) simply
   * has nothing to re-identify.
   */
  deliveryId?: string;
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

  // docs/239 — the checkout may have been reclaimed while the watch waited (a
  // merge can be days after the arm). Restore it BEFORE the runner is created,
  // so the container boots against a workspace that exists. Throws when recovery
  // is genuinely impossible (no remote, no bare cache), which the caller records
  // as a failed attempt exactly like a boot failure.
  if (deps.restoreWorkspace) await deps.restoreWorkspace(session.id);

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

  // That argument only applies when `getOrCreate` CONSTRUCTS the runner; an
  // existing one still carries whatever it was seeded with (the global default,
  // for a rescued container or a warm-pool runner). Reconcile before env-prep,
  // which reads the agent id to decide whose credentials to provision.
  const effectiveAgentId = reconcileRunnerAgent(runner, session.agentId);

  // Refresh credentials/OAuth/MCP before the turn fires (idempotent). Skipped
  // while the agent is already running — the next-starting turn's env-prep
  // covers it, and we must not race a live turn's environment.
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

  // docs/240 — `dispatch` also returns a `TurnHandle` whose `settled` promise
  // resolves exactly once with this outcome. We read the settlement through the
  // `onTurnComplete` ADAPTER rather than awaiting the handle, per the doc's
  // incremental-migration plan: the handle resolves a microtask later, and the
  // notify-on-merge state machine (and its regression suite) is written against
  // a synchronous "the turn finished" edge. The property that actually mattered
  // — the OUTCOME is passed through instead of being flattened to "delivered" —
  // holds either way, and "exactly once, including the retry and no-result
  // paths" is now enforced upstream by `runDispatchedTurn` + the executor's
  // `finally`, not by this call site.
  const onSettled = opts.onSettled;
  runner.dispatch(prepareDispatch({
    text: opts.text,
    agentInterface: undefined,
    messageOrigin: opts.messageOrigin,
    activity: opts.activity,
    systemTurn: true,
    ...(onSettled
      ? {
          onTurnComplete: (outcome: TurnOutcome) => {
            try {
              onSettled(outcome);
            } catch (err) {
              console.error(`[wake-session] settlement handler for ${session.id} threw:`, err);
            }
          },
        }
      : { onTurnComplete: undefined }),
    deliveryId: opts.deliveryId,
    execution: undefined,
    images: undefined,
    files: undefined,
    uploads: undefined,
    permissionMode: undefined,
    postTurn: undefined,
  }));
}
