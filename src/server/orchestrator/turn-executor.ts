/**
 * Shared agent-turn executor — the single code path both turn entry points run
 * through (docs/149→152 convergence; quick-session "Not logged in" follow-up).
 *
 *   - `runDispatchedTurn` (dispatched-turn.ts) — HTTP dispatch / quick / child /
 *     CI-fix turns.
 *   - `runAgentWithMessage` (ws-handlers/agent-execution.ts) — WS user-typed
 *     turns.
 *
 * Divergence is confined to the transport adapter (attachment resolution,
 * optimistic-bubble dedup, streaming-agent reuse, captured per-connection
 * state). Everything from "we have a prompt + a runner" onward — reset,
 * env-prep, spawn, listener wiring, and the post-turn commit/push/PR/drain
 * handler — lives here so the two transports cannot drift apart again. The
 * env-prep-at-spawn step is also what keeps every entry point's OAuth token
 * fresh at the moment the CLI starts (the quick-session "Not logged in" fix).
 *
 * The `runner` may be null (a tracked-but-never-claimed session answering a
 * question has no registry-backed runner). In that case the turn still spawns
 * and runs the agent; the runner-bound post-turn work (commit, drain, finished)
 * is simply skipped and emits fall back to the per-connection `emit`.
 *
 * Standalone module (like the former inline `dispatched-turn.ts`) so it can
 * import the runtime value `wireAgentListeners` without an import cycle through
 * `session-runner.ts`.
 */

import type { AgentId, AgentProcess, PermissionMode, AgentEvent, WsServerMessage } from "../shared/types.js";
import { wireAgentListeners } from "./ws-handlers/agent-listeners.js";
import { resetRunnerTurnState } from "./session-runner.js";
import type { SessionRunnerInterface, SystemTurnDeps } from "./session-runner.js";
import { formatUnresolvedConflictNotice } from "./services/conflict-marker-notice.js";

/**
 * Normalized, transport-agnostic description of one turn. The adapters
 * translate their transport-specific inputs (WS attachments / optimistic
 * bubble / streaming reuse, dispatch activity label) into this shape so the
 * executor branches only on these fields — never on "which transport".
 */
export interface TurnInput {
  agentId: AgentId;
  /** Session id used for run-params, persistence, and SSE (always defined). */
  sessionId: string;
  /** Final prompt string handed to the CLI (WS: assembled with file/image context). */
  prompt: string;
  /** Raw user text — drives the echo bubble, persisted user row, and titles. */
  userText: string;
  /** Optional activity label (dispatch); used in the echo + commit-summary fallback. */
  activity?: string;
  permissionMode?: PermissionMode;
  reviewFilePath?: string;
  /**
   * Emit a `system_user_message` bubble (dispatch — the orchestrator initiated
   * the message) vs. rely on the client's already-rendered optimistic bubble
   * (WS user-typed).
   */
  emitUserEcho: boolean;
  /** Persist the user row (transport owns the payload shape: text-only vs. +images/files). */
  persistUserMessage: (sessionId: string) => void;
  isNewSession: boolean;
  /**
   * docs/179 — set on the auth-retry re-dispatch (a turn re-run after a healed
   * runtime 401). Suppresses a SECOND recovery attempt: if the retry also hits
   * `auth_required`, the listener surfaces the sign-in card normally instead of
   * looping. Absent on a first attempt.
   */
  isAuthRetry?: boolean;
  /**
   * docs/179 — shared "user row persisted" latch, threaded from the original
   * attempt into the auth-retry so the user message is persisted exactly once
   * across both. Created internally when absent.
   */
  persistGuard?: { done: boolean };
  /** Fallback chat title when AI naming hasn't produced one yet. */
  fallbackTitle: string;
  /** HEAD at turn start, for the "branch tip moved, no working-tree change" auto-push. */
  turnStartHeadHash: string | null;
  /** Start the next queued message (each transport supplies its own re-entry). */
  drainNext: () => Promise<void>;
  /** Broadcast to viewers (runner.emitMessage) with a per-connection fallback for a null runner. */
  emit: (msg: WsServerMessage) => void;
  /**
   * Live-steering streaming mode (docs/140). Keys the post-turn handler: when
   * true, the full post-turn flow fires on `agent_result` (the process stays
   * resident across turns) and `done` only handles process-exit cleanup.
   */
  useStreaming?: boolean;
  /**
   * The passed `agent` is a *reused* resident streaming process (docs/140):
   * carry the message in via `sendUserMessage` instead of `/agent/start`.
   */
  reuseExistingAgent?: boolean;
  /**
   * Emit a client `error` message when the process exits without an
   * `agent_result` (WS). Dispatch leaves this off — system turns surface
   * failures via the chat-history error rows the listener writes.
   */
  emitErrorOnNoResult?: boolean;
  /**
   * Preserve a partial interrupted turn (flip in-progress rows to persisted).
   * WS supplies it; dispatch omits it.
   */
  onInterruptedTurn?: () => void;
  /**
   * Dispatch-only hook fired when the process exits WITHOUT ever producing an
   * `agent_result` (and the turn wasn't user-interrupted or auth-blocked).
   *
   * This is the "quick-session first turn silently never ran" bug
   * (docs/163): on the warm-reconnect dispatch path the worker can accept
   * `/agent/start` yet the CLI exits with code 0 having done no work — no
   * edits, no commit, no error. The WS path surfaces this via
   * `emitErrorOnNoResult`, but dispatch left it unset, so the `done` handler
   * fell straight through to the normal drain/commit/finished teardown and
   * reported a *completed* turn. That silent success is the masking bug.
   *
   * Returning `true` means the hook took over the turn's completion (it
   * dispatched a retry that now owns drain/commit/finished, or surfaced an
   * error via the agent's error path) — the executor must NOT finalize this
   * turn as completed. Returning `false`/omitting it leaves the legacy
   * teardown in place.
   */
  onNoResultExit?: (code: number | null) => Promise<boolean>;
  /**
   * docs/169 — post-turn policy. `"commit-push"` (default) runs the normal
   * commit/push/PR + queue drain. `"none"` elides auto-commit, auto-push, the
   * PR flow, AND the queue drain — used by the rebase driver, which commits
   * via `git rebase --continue` and force-pushes after the whole flow; an
   * auto-commit mid-rebase would corrupt it. `running` is still cleared so a
   * multi-turn driver can dispatch the next turn.
   */
  postTurn?: "commit-push" | "none";
  /**
   * docs/169 — this turn set `runner.systemTurnInProgress` (via `dispatch`'s
   * `systemTurn` option). The executor clears it on the terminal teardown so
   * live steering is re-enabled exactly once the turn ends — on the clean
   * `done` path AND the agent-error path.
   */
  systemTurn?: boolean;
  /**
   * docs/169 — fired exactly once on terminal teardown. `errored` is true when
   * the turn ended via an agent process error (so a multi-turn driver can
   * abort) and false on a clean completion.
   */
  onTurnComplete?: (outcome: { errored: boolean }) => void;
}

/**
 * Run a single agent turn end-to-end. `runner` may be null for a degenerate
 * workspace-less session (the agent still spawns; runner-bound post-turn work
 * is skipped). Async because env-prep + run-params assembly are async; the
 * adapters fire-and-forget.
 */
export async function executeAgentTurn(
  runner: SessionRunnerInterface | null,
  deps: SystemTurnDeps,
  agent: AgentProcess,
  input: TurnInput,
): Promise<void> {
  const { agentId, prompt, activity, sessionId, emit } = input;
  const useStreaming = input.useStreaming ?? false;
  // docs/169 — "none" elides commit/push/PR + queue drain (rebase). Default
  // preserves today's behavior for every other caller.
  const postTurn = input.postTurn ?? "commit-push";

  // docs/169 — terminal completion signal. Fires exactly once (guarded) on the
  // clean `done` path or the agent-error path: clears the system-turn flag this
  // turn set and hands control back to a multi-turn driver (the rebase loop).
  let turnErrored = false;
  let turnCompleteFired = false;
  const finishTurn = (): void => {
    if (turnCompleteFired) return;
    turnCompleteFired = true;
    if (input.systemTurn && runner) runner.systemTurnInProgress = false;
    input.onTurnComplete?.({ errored: turnErrored });
  };

  if (runner) {
    runner.running = true;
    runner.isStreamingActive = useStreaming;
    resetRunnerTurnState(runner, { reviewFilePath: input.reviewFilePath ?? null });
  }

  // docs/179 — persist the user row EXACTLY ONCE across the original attempt and
  // a possible auth-retry re-dispatch. Without a shared guard, the retry would
  // either duplicate the user bubble (resumed session: persisted synchronously
  // below) or drop it (new session: the listener persists on `agent_init`, which
  // never fires if auth fails first). The guard is threaded into the retry via
  // `input.persistGuard` so both attempts share one latch.
  const persistGuard = input.persistGuard ?? { done: false };
  const persistUserMessageOnce = (sid: string): void => {
    if (persistGuard.done) return;
    persistGuard.done = true;
    input.persistUserMessage(sid);
  };

  // docs/179 — runtime-401 auto-recovery. `willRecoverAuth` is the synchronous
  // gate the auth_required listener calls BEFORE it kills the agent (and thus
  // before `done` fires): it returns true only for a first-attempt turn with a
  // healer wired, and flips `authRecoveryInProgress` so the `done` handler
  // stands down and lets the recovery own all terminal work. `recoverAuth`
  // then heals the OAuth token and, if it's usable again, re-dispatches THIS
  // turn once on a fresh agent (same assembled prompt, so attachments and
  // slash commands survive). A transient stale-token 401 thus recovers with no
  // sign-in card and no manual re-send.
  let authRecoveryInProgress = false;
  const canRecoverAuth = !input.isAuthRetry && !!deps.ensureAgentTokenFresh;
  const willRecoverAuth = (): boolean => {
    if (!canRecoverAuth) return false;
    authRecoveryInProgress = true;
    return true;
  };
  const recoverAuth = async (): Promise<boolean> => {
    let healed = false;
    try {
      healed = deps.ensureAgentTokenFresh ? await deps.ensureAgentTokenFresh(agentId) : false;
    } catch (err) {
      console.error("[turn] auth heal failed:", err);
      healed = false;
    }
    if (!healed) {
      // Heal genuinely failed (token revoked / rate-limited / no rotation). The
      // `done` handler stood down for us, so run the same terminal teardown it
      // would have, then return false so the listener surfaces the sign-in card.
      if (runner) runner.running = false;
      await tryDrain();
      await runCommitAndPr();
      emitFinishedIfIdle();
      finishTurn();
      return false;
    }
    // Healed — re-dispatch this turn once on a fresh agent. The retried turn
    // owns drain/commit/finished, so we must NOT run them here. `isAuthRetry`
    // prevents a second recovery (one quiet retry, then the card surfaces);
    // the shared `persistGuard` keeps the user row at exactly one copy.
    console.log(`[turn] auth healed for ${sessionId}; re-dispatching turn (quiet auth retry)`);
    const freshAgent = deps.agentFactory(agentId);
    if (runner) runner.setAgent(freshAgent);
    await executeAgentTurn(runner, deps, freshAgent, {
      ...input,
      isAuthRetry: true,
      reuseExistingAgent: false,
      emitUserEcho: false,
      persistGuard,
    });
    return true;
  };

  // Surface the user message. Dispatch emits a `system_user_message` bubble (no
  // client-side optimistic bubble to dedupe against); WS skips the echo.
  if (input.emitUserEcho) {
    emit({ type: "system_user_message", text: input.userText, activity });
  }
  deps.listenerDeps.sseBroadcast("session_agent_started", { sessionId, activity });

  // Shared listener: handles agent_init/assistant/tool_result/result/error,
  // accumulates `chatMessageGroups`, persists message groups on agent_result,
  // and writes error rows on auth_required / process error.
  wireAgentListeners(agent, runner, deps.listenerDeps, {
    isNewSession: input.isNewSession,
    persistUserMessage: persistUserMessageOnce,
    fallbackTitle: input.fallbackTitle,
    capturedSessionId: sessionId,
    // docs/179 — auto-recovery hooks: the listener calls `willRecoverAuth`
    // synchronously to decide whether to suppress the sign-in card, then
    // `recoverAuth` to heal + re-dispatch. Omitted when this turn can't recover
    // (already a retry, or no healer) so the listener keeps the legacy flow.
    ...(canRecoverAuth ? { willRecoverAuth, recoverAuth } : {}),
    ...(input.permissionMode !== undefined ? { requestedPermissionMode: input.permissionMode } : {}),
    // Route the error-path drain through the SAME guarded `tryDrain` the
    // agent_result / done paths use, so a process that both errors AND exits
    // can't drain the queue twice. (Defined below; the closure defers the
    // reference until the error actually fires.)
    // docs/169 — mark the turn errored and fire the completion signal here too,
    // so a multi-turn driver (rebase loop) unblocks-and-aborts even when the
    // process errors without a subsequent `done` event.
    onError: () => { turnErrored = true; finishTurn(); return tryDrain(); },
    ...(input.useStreaming !== undefined ? { useStreaming: input.useStreaming } : {}),
  });

  // For a resumed session (id already known) persist the user row synchronously
  // before the turn. New sessions defer to the listener's `isNewSession` branch.
  if (!input.isNewSession) {
    persistUserMessageOnce(sessionId);
  }

  // --- post-turn plumbing (first-wins guards so whichever of agent_result /
  // done arrives first advances state and the other becomes a no-op) ---
  let receivedResult = false;

  // An auth-required turn legitimately ends without an `agent_result` — the
  // listener already wrote a visible row and kicked off the OAuth flow, so it
  // must NOT trip the no-result retry/surface path below (which would re-run a
  // turn that can only fail auth again).
  let sawAuthRequired = false;
  agent.on("auth_required", () => { sawAuthRequired = true; });

  let tokenSyncFired = false;
  const trySyncToken = (): void => {
    if (tokenSyncFired) return;
    tokenSyncFired = true;
    deps.finalizeAgentEnv?.(sessionId, agentId);
  };

  let drainFired = false;
  const tryDrain = async (): Promise<void> => {
    if (drainFired) return;
    drainFired = true;
    if (runner) runner.running = false;
    // docs/169 — `postTurn: "none"` (rebase) still clears `running` so the
    // driver can dispatch the next resolution turn, but must NOT drain the
    // queue mid-rebase: a user message queued during conflict resolution
    // drains only after the rebase fully settles (the driver's own
    // `drainQueue` callback owns that).
    if (postTurn === "none") return;
    await input.drainNext();
  };

  const runCommit = async (): Promise<string | null> => {
    // No runner / no workspace on disk → nothing to commit. Mirrors the WS
    // path's `if (sessionDir)` guard and keeps git off the orchestrator's cwd.
    if (!runner?.sessionDir) return null;
    // Fallback chain: assistant-derived summary → dispatch activity label →
    // "Agent turn" (the unified default `postTurnCommit` also applies).
    const summary = runner.turnSummary.split("\n")[0]?.slice(0, 120) || activity || "Agent turn";
    try {
      if (deps.commitTurn) {
        return await deps.commitTurn({
          sessionDir: runner.sessionDir,
          sessionId,
          summary,
          turnStartHeadHash: input.turnStartHeadHash,
          runner,
          emit,
        });
      }
      // Fallback for minimal test setups that wire `autoCommit` but not `commitTurn`.
      const result = await deps.autoCommit(runner.sessionDir, summary);
      if (result.conflictedFiles.length > 0 || result.rebaseInProgress) {
        emit({
          type: "system_notice",
          sessionId,
          level: "warn",
          message: formatUnresolvedConflictNotice({
            conflictedFiles: result.conflictedFiles,
            rebaseInProgress: result.rebaseInProgress,
          }),
        });
      }
      if (!result.commitHash) return null;
      emit({ type: "git_committed", hash: result.commitHash, message: summary });
      deps.scheduleAutoPush(runner.sessionDir);
      if (result.parentHash) {
        runner.pendingCommitLink = { commitHash: result.commitHash, parentCommitHash: result.parentHash };
        const updatedId = deps.listenerDeps.chatHistoryManager.updateLastMessage(sessionId, {
          commitHash: result.commitHash,
          parentCommitHash: result.parentHash,
        });
        if (updatedId !== null) {
          runner.pendingCommitLink = null;
          const messageIndex = deps.listenerDeps.chatHistoryManager.indexOfMessageId(sessionId, updatedId);
          if (messageIndex >= 0) {
            emit({
              type: "commit_linked",
              messageIndex,
              commitHash: result.commitHash,
              parentCommitHash: result.parentHash,
            });
          }
        }
      }
      return result.commitHash;
    } catch (err) {
      console.error("[turn] auto-commit failed:", err);
      return null;
    }
  };

  const runCommitAndPr = async (): Promise<void> => {
    // docs/169 — rebase turns commit via `git rebase --continue` and force-push
    // after the whole flow; auto-committing here would corrupt the rebase.
    if (postTurn === "none") return;
    const commitHash = await runCommit();
    if (commitHash && runner) {
      try {
        await deps.postTurnPrFlow?.(sessionId, runner.sessionDir, commitHash, emit);
      } catch (err) {
        console.error("[turn] pr-lifecycle flow failed:", err);
      }
    }
    // docs/171 — react to release markers in the turn text. Fires regardless of
    // whether the turn committed: a release *proposal* turn makes no commit.
    if (runner && deps.postTurnReleaseFlow) {
      try {
        await deps.postTurnReleaseFlow(sessionId, runner.sessionDir, runner.accumulatedText, emit);
      } catch (err) {
        console.error("[turn] release flow failed:", err);
      }
    }
  };

  const emitFinishedIfIdle = (): void => {
    if (runner?.running) return;
    deps.listenerDeps.sseBroadcast("session_agent_finished", { sessionId });
    runner?.onAgentFinished();
  };

  // agent_result is the canonical turn-ended signal. For streaming the resident
  // process stays alive, so the WHOLE post-turn flow fires here (guarded once);
  // for non-streaming we sync the token + drain the queue here and leave
  // commit/PR/finished to `done` (the slow git work runs after the client has
  // cleared queued state).
  let streamingPostTurnFired = false;
  agent.on("event", async (event: AgentEvent) => {
    if (event.type !== "agent_result") return;
    receivedResult = true;
    if (useStreaming) {
      if (streamingPostTurnFired) return;
      streamingPostTurnFired = true;
      trySyncToken();
      // agent-listeners already set running=false; the resident process is NOT
      // cleared (the next top-level turn reuses it via reuseExistingAgent).
      // Drain through the guarded `tryDrain` (not `input.drainNext` directly)
      // so the streaming `done` handler's drain — added for the abnormal-exit
      // case below — can't double-drain after this normal end-of-turn drain.
      await tryDrain();
      await runCommitAndPr();
      emitFinishedIfIdle();
    } else {
      trySyncToken();
      await tryDrain();
    }
  });

  agent.on("done", async (code: number | null) => {
    console.log("[turn] agent exited with code", code);
    deps.listenerDeps.broadcastLog("server", `Agent process exited with code ${code}`);
    // docs/179 — this turn's auth failure is being auto-recovered: `recoverAuth`
    // owns the agent ref, the re-dispatch, and ALL terminal work (drain / commit
    // / finished). Stand down so we don't double-drain, emit a spurious error,
    // or finalize a turn that's about to be retried.
    if (authRecoveryInProgress) return;
    // Identity-guard: only clear the runner's agent ref if it still points at
    // *this* turn's agent. A later turn (started by the drain above) already
    // called `setAgent(NEW)`; clobbering to null would strand it and the SSE
    // relay would log `[sse-drop] ... dropped (no _agent)` for every event.
    if (runner) {
      if (runner.getAgent() === agent) {
        runner.setAgent(null);
        // docs/140 — the resident streaming process has actually exited; the next
        // mid-turn send must not be routed through `sendUserMessage` (closed stdin).
        if (useStreaming) runner.isStreamingActive = false;
      }
    }

    // Non-streaming captures the token here too (fallback if agent_result was
    // lost); streaming already synced in the agent_result block.
    if (!useStreaming) trySyncToken();

    // Process exited without a result event — let the client clear its loading
    // state instead of hanging. WS-only; dispatch surfaces failures via the
    // listener's error rows.
    if (input.emitErrorOnNoResult && !receivedResult && !(runner?.wasInterrupted ?? false)) {
      emit({
        type: "error",
        message: code !== 0 ? `Agent process exited with code ${code}` : "Agent process ended without a response",
      });
    }
    // Preserve the partial turn whenever the process ended without an
    // `agent_result` — whether the user interrupted (the "first turn erased
    // from history" bug, docs/156) OR the process exited abnormally, e.g.
    // SIGTERM / "exited with code 143" from an idle-kill, container restart, or
    // crash. The streamed assistant rows were written as `in_progress=1` at each
    // tool-result boundary; without finalizing them here they stay in-progress,
    // and the NEXT user message's turn calls `replaceInProgress()`, which
    // deletes every `in_progress=1` row — erasing the previous turn from the UI
    // on reload. `onInterruptedTurn` flips those rows to finalized (and clears
    // the replay buffer). Skipped on the auth-required path, where the listener
    // already owns the visible row. WS-only: dispatch leaves `onInterruptedTurn`
    // unset and surfaces no-result exits via `onNoResultExit` instead.
    if (!receivedResult && !sawAuthRequired) {
      input.onInterruptedTurn?.();
    }

    if (useStreaming) {
      // Streaming post-turn (commit/PR) ran on agent_result when the turn ended
      // cleanly; done is normally process-exit cleanup only. BUT a streaming
      // process can exit WITHOUT an `agent_result` (crash, hook-induced abort,
      // failed-PR/hook-retry state) — in which case agent_result never drained
      // the queue and a message enqueued via the dispatch path would be
      // stranded forever ("queued, then never delivered"). `tryDrain` is
      // guarded by `drainFired`, so it's a no-op when agent_result already
      // drained and only fires here on the abnormal-exit path. The done handler
      // above already cleared the resident ref + `isStreamingActive`, so the
      // drained turn spawns a fresh agent rather than writing to dead stdin.
      if (runner) runner.running = false;
      await tryDrain();
      emitFinishedIfIdle();
      finishTurn();
      return;
    }

    // Process exited without ever producing a turn result (the dispatched
    // "first turn never ran" bug). Hand off to the dispatch retry/surface hook
    // BEFORE the normal teardown — otherwise we'd report a completed turn for a
    // turn that did nothing. If the hook claims the turn (retry dispatched or
    // error surfaced) we stop here; the new turn / error path owns drain +
    // commit + finished. WS leaves `onNoResultExit` unset and is unaffected.
    if (
      input.onNoResultExit &&
      !receivedResult &&
      !sawAuthRequired &&
      !(runner?.wasInterrupted ?? false)
    ) {
      const handled = await input.onNoResultExit(code);
      if (handled) return;
    }

    // Non-streaming: drain first (clears queued visual state before the slow
    // commit), then commit/PR, then finished. All guarded so a prior
    // agent_result that already drained/synced makes these no-ops.
    await tryDrain();
    await runCommitAndPr();
    emitFinishedIfIdle();
    // docs/169 — hand control back to a multi-turn driver (rebase loop) and
    // clear the system-turn flag, after all post-turn work has settled.
    finishTurn();
  });

  try {
    // Sync the freshest OAuth token (and provision/pin on the first turn)
    // immediately before spawn — the quick-session "Not logged in" fix.
    // `buildRunParams` reads `agentSessionId` from the DB, which env-prep's
    // docs/153 leak repair updates as a side-effect, so resume recovery is
    // honored automatically.
    //
    // Both steps are timed: this is the pre-spawn gap where an un-timed
    // network await once stalled the whole turn before `agent.run()` fired
    // (the worker never saw `/agent/start`). prepareAgentEnv is internally
    // fail-open + time-bounded; the logs make any residual slowness visible.
    const envBegan = Date.now();
    await deps.prepareAgentEnv?.(sessionId, agentId);
    console.log(`[turn] env-prep for ${sessionId} took ${Date.now() - envBegan}ms`);

    if (input.reuseExistingAgent) {
      // docs/140 — carry the message into the resident streaming process. Push
      // a permission-mode change first if the user toggled the chip between
      // turns, else the CLI keeps its spawn-time mode for life. Fires even for
      // `undefined` (toggling back to the CLI's no-flag "auto" default).
      if (runner && runner.appliedPermissionMode !== input.permissionMode && agent.setPermissionMode) {
        agent.setPermissionMode(input.permissionMode);
        runner.appliedPermissionMode = input.permissionMode;
      }
      agent.sendUserMessage(prompt);
    } else {
      const paramsBegan = Date.now();
      const runParams = await deps.buildRunParams(sessionId, agentId, prompt);
      console.log(`[turn] build-run-params for ${sessionId} took ${Date.now() - paramsBegan}ms; spawning agent`);
      // WS always carries `useStreaming` (true or false); dispatch leaves it
      // undefined so the run params are unchanged from the system-turn shape.
      agent.run(input.useStreaming !== undefined ? { ...runParams, useStreaming: input.useStreaming } : runParams);
      if (runner) runner.appliedPermissionMode = input.permissionMode;
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    agent.emit("error", error);
  }
}
