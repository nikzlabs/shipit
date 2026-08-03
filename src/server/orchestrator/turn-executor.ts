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

import type { AgentId, AgentProcess, PermissionMode, AgentEvent, WsServerMessage, SessionMessageOrigin } from "../shared/types.js";
import { buildTurnMessages, wireAgentListeners } from "./ws-handlers/agent-listeners.js";
import { detectHardExhaustion } from "./ws-handlers/agent-rate-limits.js";
import { resetRunnerTurnState } from "./session-runner.js";
import type { SessionRunnerInterface, SystemTurnDeps } from "./session-runner.js";
import { formatUnresolvedConflictNotice } from "./services/conflict-marker-notice.js";
import { formatSecretScanNotice } from "./services/secret-scan-notice.js";
import { emitChatCard, emitNoticePostTurn } from "./chat-card-persistence.js";
import { TURN_COMPLETED, turnErrored, turnNoResult, type TurnOutcome } from "./turn-settlement.js";
import type { AgentInterfaceProvenance } from "../shared/agent-interface-sdk/protocol.js";

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
  agentInterface?: AgentInterfaceProvenance;
  /** Another session's agent supplied this prompt, rather than the user. */
  messageOrigin?: SessionMessageOrigin;
  /** Optional activity label (dispatch); used in the echo + commit-summary fallback. */
  activity?: string;
  permissionMode?: PermissionMode;
  /**
   * Emit a `system_user_message` bubble (dispatch — the orchestrator initiated
   * the message) vs. rely on the client's already-rendered optimistic bubble
   * (WS user-typed).
   */
  emitUserEcho: boolean;
  /** Persist the user row (transport owns the payload shape: text-only vs. +images/files). */
  persistUserMessage: (sessionId: string) => void;
  /**
   * docs/218 — fired exactly once, immediately AFTER the resumed user row is
   * persisted and AFTER `resetRunnerTurnState` has cleared the turn (so anything
   * recorded here survives), and BEFORE the agent runs. Used by the WS path to
   * emit the pre-turn "branch updated to latest base" card via `emitChatCard` so
   * it interleaves right after the user message. Omitted on turns that don't
   * reset; never fires for a new session (its user row persists in the listener).
   */
  afterUserMessagePersisted?: (sessionId: string) => void;
  isNewSession: boolean;
  /**
   * docs/179 — set on the auth-retry re-dispatch (a turn re-run after a healed
   * runtime 401). Suppresses a SECOND recovery attempt: if the retry also hits
   * `auth_required`, the listener surfaces the sign-in card normally instead of
   * looping. Absent on a first attempt.
   */
  isAuthRetry?: boolean;
  /** One shared retry budget for automatic auth and stale-resume recovery. */
  recoveryRetryUsed?: boolean;
  /**
   * docs/150 req 14 — set on the quota-retry re-dispatch (a turn re-run after
   * the provider killed it for subscription exhaustion). Bounds the retry to
   * exactly one: if the second account is spent too, the turn fails normally
   * rather than walking down every account one process at a time. Absent on a
   * first attempt.
   */
  isQuotaRetry?: boolean;
  /**
   * docs/179 — shared "user row persisted" latch, threaded from the original
   * attempt into the auth-retry (and docs/150's quota retry) so the user
   * message is persisted exactly once across both. Created internally when
   * absent.
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
   * docs/169 — fired exactly once on terminal teardown, with the turn's
   * {@link TurnOutcome}. `errored` is true when the turn ended via an agent
   * process error (so a multi-turn driver can abort); `status` additionally
   * distinguishes a clean `completed` from a `no-result` exit.
   *
   * docs/240 — this is the settlement hook: `dispatch` chains the handle's
   * `settle` onto it, and the `done` handler fires it from a `finally` so a turn
   * cannot exit without signalling completion. `runDispatchedTurn` owns "exactly
   * once across no-result retries" on top of it (SHI-260).
   */
  onTurnComplete?: (outcome: TurnOutcome) => void;
  /**
   * SHI-264 — durable identity of the server-side DELIVERY this turn runs on
   * behalf of. Published on the runner (`activeDeliveryId`) for the turn's
   * duration and stamped onto the spawn so the worker reports it back — the two
   * halves that let a supervisor derive "is this delivery live?" instead of
   * tracking it, across an orchestrator restart included.
   */
  deliveryId?: string;
  /**
   * docs/240 — ADOPT a turn that is already running on the worker rather than
   * starting one. Set only by the post-restart reattach path
   * (`turn-adoption.ts`): the CLI is mid-turn inside a session container that
   * outlived the orchestrator process, so there is nothing to spawn and no user
   * row to persist (the pre-restart orchestrator already wrote it). Everything
   * else is identical to a normal turn — the listeners are wired the same way,
   * so the replayed events accumulate into chat history and the post-turn
   * commit / push / PR flow fires off the replayed `agent_result`.
   */
  adopt?: boolean;
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
  //
  // docs/240 splits it in two. `settleTurn` is the SETTLEMENT half and nothing
  // else, so the `done` handler's `finally` can guarantee "a turn cannot exit
  // without settling" without also clearing `systemTurnInProgress` — which would
  // be wrong on the no-result-retry path, where the retry has already re-armed
  // that flag by the time the superseded attempt unwinds.
  let agentErrored = false;
  let turnCompleteFired = false;
  const settleTurn = (outcome: TurnOutcome): void => {
    if (turnCompleteFired) return;
    turnCompleteFired = true;
    // SHI-264 — the delivery stops being live the moment the turn settles, and
    // it must stop being live BEFORE the consumer is told: the consumer's first
    // act on a non-`completed` outcome is to ask whether a retry is warranted,
    // and a delivery still reading as in-flight would suppress it forever.
    //
    // Two guards, both load-bearing. The identity check keeps a settling turn
    // from clearing a SUCCESSOR's delivery; `!runner.running` covers the
    // no-result RETRY path, where the retry re-arms the same id and starts
    // running before this (superseded) attempt unwinds — the same shape as the
    // `systemTurnInProgress` carve-out above.
    if (
      runner &&
      input.deliveryId !== undefined &&
      runner.activeDeliveryId === input.deliveryId &&
      !runner.running
    ) {
      runner.activeDeliveryId = undefined;
    }
    input.onTurnComplete?.(outcome);
  };
  const finishTurn = (): void => {
    if (turnCompleteFired) return;
    if (input.systemTurn && runner) runner.systemTurnInProgress = false;
    // `errored` keeps its pre-docs/240 meaning ("ended via an agent process
    // error") so the existing `{ errored }` consumers — the rebase driver, the
    // CI auto-fix loop — are unaffected; `status` carries the finer distinction
    // for consumers that opt into it.
    settleTurn(
      agentErrored
        ? turnErrored()
        : receivedResult
          ? TURN_COMPLETED
          : turnNoResult("agent process exited without producing a turn result"),
    );
  };

  if (runner) {
    runner.running = true;
    // docs/169 + SHI-255 — a system turn suppresses live steering for its whole
    // duration. `dispatch` sets the flag synchronously for a turn it starts from
    // idle; a system turn that was ENQUEUED and drains later never went through
    // that branch, so set it here too (idempotent) — otherwise a wake-turn
    // drained behind a user turn would run steerable, and a message arriving
    // mid-turn would be injected into it. `finishTurn` clears it.
    if (input.systemTurn) runner.systemTurnInProgress = true;
    // SHI-264 — publish this turn's delivery for its whole duration. `dispatch`
    // already set it synchronously on the start-now path; adoption and the
    // queue-drain path reach it only here.
    //
    // Assigned unconditionally, INCLUDING to `undefined`: a turn starting is
    // proof the previous one is over, and the `settleTurn` clear above stands
    // down when a drained turn has already claimed the runner. Without this, a
    // wake-turn that ended badly and drained a user turn behind it would leave
    // its dead delivery reading as in-flight, suppressing every retry.
    runner.activeDeliveryId = input.deliveryId;
    runner.isStreamingActive = useStreaming;
    resetRunnerTurnState(runner);
  }

  // docs/179 — persist the user row EXACTLY ONCE across the original attempt and
  // a possible auth-retry re-dispatch. Without a shared guard, the retry would
  // either duplicate the user bubble (resumed session: persisted synchronously
  // below) or drop it (new session: the listener persists on `agent_init`, which
  // never fires if auth fails first). The guard is threaded into the retry via
  // `input.persistGuard` so both attempts share one latch.
  const persistGuard = input.persistGuard ?? { done: false };
  const persistUserMessageOnce = (sid: string): boolean => {
    if (persistGuard.done) return false;
    persistGuard.done = true;
    input.persistUserMessage(sid);
    return true;
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
  let automaticRecoveryInProgress = false;
  const recoveryRetryUsed = input.recoveryRetryUsed ?? input.isAuthRetry ?? false;
  const canRecoverAuth = !recoveryRetryUsed && !!deps.ensureAgentTokenFresh;
  const willRecoverAuth = (): boolean => {
    if (!canRecoverAuth) return false;
    automaticRecoveryInProgress = true;
    return true;
  };
  const recoverAuth = async (): Promise<boolean> => {
    let healed: boolean;
    try {
      // docs/150 — heal the account THIS turn is pinned to. Provider-wide,
      // the healer aggregates with `every()`, so one revoked sibling account
      // would report "couldn't heal" for a turn whose own token is fine.
      //
      // A resolver that answers `undefined` means the turn is on a reserved
      // route (`claude-api-key`, `claude-env-oauth`) — not an account, and not
      // refresher-managed. There is no OAuth token of its own to heal, so
      // rotating every *other* account's token and reporting the aggregate
      // would be answering a question nobody asked: a bad API key would look
      // healed because the subscriptions are fine, or look unhealable because
      // one of them isn't. Don't heal; let the 401 surface.
      //
      // `force: true` is what makes this heal mean anything. Unforced,
      // `ensureFresh` answers from the source token's `expiresAt` and
      // short-circuits `true` for anything with margin left — but the 401 we
      // are recovering from is itself evidence that the timestamp is lying
      // (a single-use refresh token a sibling container rotated first is dead
      // while its recorded expiry is still hours out). Production ran six
      // "auth healed" events in six hours with zero refresher log lines
      // beside them: every heal was a no-op that reported success, the turn
      // was re-dispatched ~120ms later on byte-identical credentials, and the
      // one shared recovery budget was spent for nothing.
      if (deps.resolveTurnAccountId) {
        const turnAccountId = deps.resolveTurnAccountId(sessionId);
        healed = turnAccountId && deps.ensureAgentTokenFresh
          ? await deps.ensureAgentTokenFresh(agentId, turnAccountId, { force: true })
          : false;
      } else {
        // No resolver wired (tests / local runtime): keep the pre-docs/150
        // provider-wide behaviour rather than silently disabling recovery.
        healed = deps.ensureAgentTokenFresh
          ? await deps.ensureAgentTokenFresh(agentId, undefined, { force: true })
          : false;
      }
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
    // Force the (possibly just-rotated) source token into THIS session before
    // the retry spawns. The retry's env-prep runs the ordinary sync-in, whose
    // guard skips a source that isn't strictly newer than the session's copy —
    // which is exactly the state a sibling-rotated dead token leaves behind
    // (later `expiresAt`, no longer valid). Without this the healed retry can
    // still re-spawn on the credentials that just 401'd. Best-effort.
    try {
      deps.repushSessionAgentToken?.(sessionId, agentId);
    } catch (err) {
      console.warn("[turn] 401-recovery token repush failed:", err);
    }
    if (runner) {
      // The retry starts by resetting every per-turn accumulator. Finalize any
      // output the first attempt already streamed before allowing that reset,
      // otherwise a retry that fails before producing output rebuilds history
      // from empty groups and deletes the transcript the user already saw.
      // The user row is persisted independently and guarded across attempts;
      // only the first attempt's assistant/tool groups are finalized here.
      const firstAttemptMessages = buildTurnMessages(
        runner.chatMessageGroups,
        runner.steeredMessages ?? [],
        runner.recordedCards ?? [],
        { inProgress: false },
      );
      if (firstAttemptMessages.length > 0) {
        deps.listenerDeps.chatHistoryManager.replaceInProgress(sessionId, firstAttemptMessages);
        deps.listenerDeps.chatHistoryManager.finalizeInProgress(sessionId);
      }
    }
    const freshAgent = deps.agentFactory(agentId);
    if (runner) runner.setAgent(freshAgent);
    await executeAgentTurn(runner, deps, freshAgent, {
      ...input,
      isAuthRetry: true,
      recoveryRetryUsed: true,
      reuseExistingAgent: false,
      emitUserEcho: false,
      persistGuard,
    });
    return true;
  };

  // Captured after env preparation, immediately before buildRunParams reads
  // the same DB pointer. This is the exact resume id owned by this process.
  let activeResumeSessionId: string | null = null;
  const recoverMissingConversation = (invalidId: string): boolean => {
    // eslint-disable-next-line no-restricted-syntax -- Claude-only CLI stderr/--resume recovery (docs/155)
    if (agentId !== "claude" || recoveryRetryUsed || invalidId !== activeResumeSessionId) return false;
    const current = deps.listenerDeps.sessionManager.get(sessionId)?.agentSessionId;
    if (current !== invalidId) return false; // stale process must not clear a newer pointer
    automaticRecoveryInProgress = true;
    deps.listenerDeps.sessionManager.clearAgentSessionId(sessionId);
    if (runner) {
      const partial = buildTurnMessages(
        runner.chatMessageGroups,
        runner.steeredMessages ?? [],
        runner.recordedCards ?? [],
        { inProgress: false },
      );
      if (partial.length > 0) {
        deps.listenerDeps.chatHistoryManager.replaceInProgress(sessionId, partial);
        deps.listenerDeps.chatHistoryManager.finalizeInProgress(sessionId);
      }
    }
    agent.kill();
    if (runner?.getAgent() === agent) runner.setAgent(null);
    const freshAgent = deps.agentFactory(agentId);
    if (runner) runner.setAgent(freshAgent);
    void executeAgentTurn(runner, deps, freshAgent, {
      ...input,
      recoveryRetryUsed: true,
      reuseExistingAgent: false,
      emitUserEcho: false,
      persistGuard,
    });
    return true;
  };

  // docs/150 req 14 — same-turn quota failover. When the provider kills a turn
  // because the subscription is spent, the user should not have to notice or
  // resend: the turn re-runs once on the next eligible account, "regardless of
  // what that turn has already done."
  //
  // Deliberately does NOT choose the account itself. By the time this runs the
  // listener has already benched the spent one (req 7), so the retry's own
  // env-prep is what switches: `failoverPinnedSession` sees the pinned account
  // is no longer usable, moves the session, preserves the conversation, and
  // posts the req-11 notice. That also gives the no-account-left case for free
  // — env-prep throws `ProviderRouteUnavailableError` and the retry surfaces
  // req 13's "every account is out of quota, earliest reset at X", which is a
  // better message than the raw provider error this attempt died of.
  //
  // Side effects from the failed attempt are kept, not rolled back: req 14 is
  // explicit that a mid-turn exhaustion retries regardless of what the turn
  // already did. Its partial output has already been finalized into history by
  // the listener, so the retry's fresh in-progress turn appends below it rather
  // than colliding with it — the transcript reads as attempt, notice, retry.
  let quotaRetryInProgress = false;
  const retryOnNextAccount = async (): Promise<void> => {
    console.log(
      `[turn] ${agentId} reported quota exhaustion for ${sessionId}; `
      + "retrying once on the next eligible account",
    );
    // The dying process still holds the spent account's token. Kill it before
    // the retry re-provisions, so nothing keeps spending the account we just
    // benched. Its `done` fires into the stood-down handler below.
    try {
      agent.kill();
    } catch {
      // Already gone is the state we wanted.
    }
    const freshAgent = deps.agentFactory(agentId);
    if (runner) {
      runner.setAgent(freshAgent);
      // The resident streaming process died with the account; the retry spawns
      // its own. Left set, the next turn would try to steer into a dead pipe.
      runner.isStreamingActive = false;
    }
    await executeAgentTurn(runner, deps, freshAgent, {
      ...input,
      isQuotaRetry: true,
      reuseExistingAgent: false,
      emitUserEcho: false,
      persistGuard,
    });
  };

  // Surface the user message. Dispatch emits a `system_user_message` bubble (no
  // client-side optimistic bubble to dedupe against); WS skips the echo.
  if (input.emitUserEcho) {
    emit({
      type: "system_user_message",
      sessionId,
      text: input.userText,
      activity,
      ...(input.agentInterface ? { agentInterface: input.agentInterface } : {}),
      ...(input.messageOrigin ? { messageOrigin: input.messageOrigin } : {}),
    });
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
    // eslint-disable-next-line no-restricted-syntax -- Claude-only CLI stderr/--resume recovery (docs/155)
    ...(!recoveryRetryUsed && agentId === "claude" ? { recoverMissingConversation } : {}),
    ...(input.permissionMode !== undefined ? { requestedPermissionMode: input.permissionMode } : {}),
    // Route the error-path drain through the SAME guarded `tryDrain` the
    // agent_result / done paths use, so a process that both errors AND exits
    // can't drain the queue twice. (Defined below; the closure defers the
    // reference until the error actually fires.)
    // docs/169 — mark the turn errored and fire the completion signal here too,
    // so a multi-turn driver (rebase loop) unblocks-and-aborts even when the
    // process errors without a subsequent `done` event.
    // ...and commit. An adapter-level `error` can be terminal with no
    // following `done` (spawn failure, an `agent_error` SSE from the worker
    // whose `agent_done` never arrives), so this is the turn's last chance to
    // get its partial edits into git. `tryDrain` only commits when a turn is
    // queued behind this one, so an errored turn with an empty queue committed
    // nothing. Ordered after the drain for the SHI-262 reason: with a queue,
    // `tryDrain` has already committed and this reuses that commit; with none,
    // `drainNext` starts nothing, so no later turn's edits can be swept into
    // this turn's commit.
    onError: async () => {
      agentErrored = true;
      finishTurn();
      await tryDrain();
      await runCommitAndPr();
    },
    ...(input.useStreaming !== undefined ? { useStreaming: input.useStreaming } : {}),
  });

  // For a resumed session (id already known) persist the user row synchronously
  // before the turn. New sessions defer to the listener's `isNewSession` branch.
  if (!input.isNewSession) {
    // docs/218 — fire the post-persist hook ONLY when this call actually wrote
    // the user row (not on an auth-retry re-dispatch, where the guard short-
    // circuits). The hook emits the pre-turn "branch updated" card via
    // `emitChatCard` right after the user row, so the card lands at its true
    // transcript position — after the user bubble, before the agent's response —
    // and inside the fresh turn (post `resetRunnerTurnState`, so it isn't wiped).
    if (persistUserMessageOnce(sessionId)) {
      input.afterUserMessagePersisted?.(sessionId);
    }
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
    // SHI-262 — the finished turn's edits MUST be in git before a queued turn
    // starts. A queued turn is free to begin by discarding working-tree state
    // (`git reset --hard`, `git checkout -f`, a branch reset); edits that never
    // entered git have no reflog entry and no way back, so draining first is a
    // silent, unrecoverable data-loss window. Only the LOCAL half runs here —
    // `commitOnce` is `git add -A` + `git commit` + chat-history bookkeeping,
    // and the push it arms is a debounced timer (`scheduleAutoPush`), not a
    // network call. The network half (PR card, re-arm, release flow) stays
    // behind the drain in `runCommitAndPr`, so two back-to-back user messages
    // still never wait on a GitHub round-trip.
    //
    // Gated on something actually being queued: every `drainNext` implementation
    // (WS, dispatch, adoption) starts a turn only when `queueLength > 0`, so on
    // the ordinary empty-queue turn end nothing moves and the commit stays
    // where it was — after the `session_agent_finished` SSE broadcast, which
    // must not be delayed by post-turn work (see `broadcastFinishedIfIdle`).
    if ((runner?.queueLength ?? 0) > 0) await commitOnce();
    await input.drainNext();
  };

  const runCommit = async (): Promise<string | null> => {
    // docs/169 — rebase turns commit via `git rebase --continue`; auto-committing
    // would corrupt the rebase. Guarded here as well as in `runCommitAndPr` so
    // no caller of `commitOnce` can reach the commit on that path.
    if (postTurn === "none") return null;
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
      if (result.secretFindings.length > 0) {
        emitNoticePostTurn(
          emit,
          deps.listenerDeps.chatHistoryManager,
          sessionId,
          formatSecretScanNotice(result.secretFindings),
          "warn",
        );
      }
      if (result.conflictedFiles.length > 0 || result.rebaseInProgress) {
        emitNoticePostTurn(
          emit,
          deps.listenerDeps.chatHistoryManager,
          sessionId,
          formatUnresolvedConflictNotice({
            conflictedFiles: result.conflictedFiles,
            rebaseInProgress: result.rebaseInProgress,
          }),
          "warn",
        );
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

  /**
   * SHI-262 — run the local auto-commit at most once per turn, whichever path
   * reaches it first. `tryDrain` calls this ahead of starting a queued turn;
   * `runCommitAndPr` calls it on the ordinary path. Memoizing the PROMISE (not
   * the resolved hash) means a second caller arriving while the commit is still
   * in flight awaits the same commit instead of racing a second `git add -A`.
   */
  let commitPromise: Promise<string | null> | null = null;
  const commitOnce = (): Promise<string | null> => (commitPromise ??= runCommit());

  const runCommitAndPrInner = async (): Promise<void> => {
    // docs/169 — rebase turns commit via `git rebase --continue` and force-push
    // after the whole flow; auto-committing here would corrupt the rebase.
    if (postTurn === "none") return;
    const commitHash = await commitOnce();
    if (commitHash && runner) {
      try {
        await deps.postTurnPrFlow?.(sessionId, runner.sessionDir, commitHash, emit);
      } catch (err) {
        console.error("[turn] pr-lifecycle flow failed:", err);
      }
    }
    // docs/216 — re-arm a merged session whose branch was reset to a clean base.
    // Fires regardless of whether the turn committed: a `git reset --hard` leaves
    // a clean tree, so `commitHash` is null and the PR flow above is skipped, yet
    // the stale merged card must still be cleared. No-op unless merged + at base.
    if (runner && deps.postTurnReArmReset) {
      try {
        await deps.postTurnReArmReset(sessionId, runner.sessionDir, emit);
      } catch (err) {
        console.error("[turn] pr re-arm (reset) flow failed:", err);
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

  /**
   * Run the post-turn flow at most once per turn, whichever terminal path
   * reaches it first. `commitOnce` already made the COMMIT single-shot, but
   * the PR / re-arm / release flows around it were not, and this turn now has
   * four terminal paths that need them (clean end, streaming abnormal exit,
   * agent error, failed auth heal) instead of the two it had when only the
   * commit needed guarding. Memoizing the promise — not the completion — means a
   * second caller arriving mid-flight awaits the same flow rather than starting a
   * duplicate PR round-trip.
   */
  let commitAndPrPromise: Promise<void> | null = null;
  const runCommitAndPr = (): Promise<void> => (commitAndPrPromise ??= runCommitAndPrInner());

  // The SSE `session_agent_finished` broadcast is a pure UI signal aimed at
  // OTHER tabs/viewers — the active viewer already learned `running=false` over
  // its per-session WS the instant agent-listeners flipped the flag. We fire it
  // as soon as the turn is idle, BEFORE the post-turn commit/PR work, so a
  // backgrounded or second tab's sidebar drops the session's "running" state
  // (and re-derives its true attention reason) without waiting out the
  // potentially multi-second git/PR flow. Without this split the SSE lagged the
  // WS by the whole commit duration, leaving other tabs stale on completion.
  // Guarded by `running` so a back-to-back queued turn that `tryDrain` just
  // started suppresses a spurious finished→started flicker.
  //
  // SHI-262 caveat: when a message IS queued, `tryDrain` commits before starting
  // it, so this broadcast lands after that commit. That path is suppressed by
  // the `running` guard anyway (the drained turn is already running), so the
  // promptness property above is unaffected — it only ever mattered for the
  // empty-queue turn end, where the commit still runs after this fires.
  const broadcastFinishedIfIdle = (): void => {
    if (runner?.running) return;
    deps.listenerDeps.sseBroadcast("session_agent_finished", { sessionId });
  };

  // The runner "idle" event drives auto-remediation (CI fix / conflict
  // resolve), so it must fire only AFTER the post-turn commit/PR work has
  // landed — else a remediation turn could kick off against a pre-commit tree.
  // Kept separate from the SSE broadcast above for exactly this reason.
  const signalIdleIfIdle = (): void => {
    if (runner?.running) return;
    runner?.onAgentFinished();
  };

  // Combined helper for paths with no post-turn commit between the drain and
  // the finish (the streaming abnormal-exit `done` path): the SSE signal and
  // the idle event fire together.
  const emitFinishedIfIdle = (): void => {
    broadcastFinishedIfIdle();
    signalIdleIfIdle();
  };

  // agent_result is the canonical turn-ended signal. For streaming the resident
  // process stays alive, so the WHOLE post-turn flow fires here (guarded once);
  // for non-streaming we sync the token + drain the queue here and leave
  // commit/PR/finished to `done` (the slow git work runs after the client has
  // cleared queued state).
  //
  // SHI-262 — note that the non-streaming branch drains HERE, at `agent_result`,
  // while its commit runs later in `done`. Reordering the two statements in the
  // `done` handler would therefore have fixed nothing; the guarantee has to live
  // inside `tryDrain`, which is the one point every drain path goes through.
  let streamingPostTurnFired = false;
  agent.on("event", async (event: AgentEvent) => {
    if (event.type !== "agent_result") return;
    receivedResult = true;
    // docs/150 req 14 — before ANY post-turn work. Draining the queue or
    // broadcasting "finished" here would tell the user (and the next queued
    // turn) that a turn we are about to re-run is over. The retry owns
    // drain / commit / finished, exactly as the auth retry does.
    //
    // Reads the RAW error: `wireAgentListeners` normalizes onto its own local
    // copy of the event, so its rewrite is not visible here. Both providers'
    // raw usage-limit text is covered by the same detector.
    if (!input.isQuotaRetry && event.error && detectHardExhaustion(event.error)) {
      quotaRetryInProgress = true;
      await retryOnNextAccount();
      return;
    }
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
      broadcastFinishedIfIdle();
      await runCommitAndPr();
      signalIdleIfIdle();
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
    if (automaticRecoveryInProgress) return;
    // docs/150 req 14 — same stand-down for the quota retry: `retryOnNextAccount`
    // killed this process on purpose and the re-dispatched turn owns every
    // terminal step. Without this, the kill's `done` would drain the queue and
    // finalize a turn that is being re-run.
    if (quotaRetryInProgress) return;
    // docs/240 — everything below is wrapped so the turn SETTLES on every exit
    // path, including the early `return`s. The one that mattered is the
    // no-result hand-off near the bottom: it returns without calling
    // `finishTurn`, which is exactly how SHI-260's callback ended up firing zero
    // times. Settling here is the structural version of that fix — a branch
    // added later that forgets to finish the turn still settles it, and
    // `runDispatchedTurn`'s attempt filter discards the settlement of an attempt
    // a retry has already superseded.
    try {
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
          // docs/235 — the CLI reaps its background tasks when it exits, so drop
          // our copy rather than leaving a stale count pinning `agentBusy` true
          // and blocking idle reclaim forever.
          runner.clearBackgroundTasks();
        }
      }

      // Non-streaming captures the token here too (fallback if agent_result was
      // lost); streaming already synced in the agent_result block.
      if (!useStreaming) trySyncToken();

      // Process exited without a result event — let the client clear its loading
      // state instead of hanging. WS-only; dispatch surfaces failures via the
      // listener's error rows.
      //
      // Skipped on the auth path for the same reason `onInterruptedTurn` is
      // (see the block below and the `sawAuthRequired` declaration): an
      // auth-required turn legitimately ends without an `agent_result`, and the
      // listener has already written the actionable, PERSISTED explanation.
      // Adding a generic "Agent process ended without a response" beside it is
      // both redundant and worse than redundant now — it is emit-only, so the
      // transcript would show two errors live and one after a reload.
      //
      // PERSISTED, not merely emitted, for the same reason as the auth notice
      // (CLAUDE.md "Chat transcript content MUST be persisted"). This is the
      // whole user-visible outcome of a turn that produced nothing: emit-only,
      // it reaches nobody when no viewer is attached at the exit instant and
      // vanishes on the next switch/reload for everyone else — leaving a user
      // message with no reply, which is the shape of the production incident.
      // Recorded in-band (rather than appended) so the `onInterruptedTurn`
      // finalize immediately below rebuilds it at its true position alongside
      // whatever partial output the turn did stream.
      if (
        input.emitErrorOnNoResult
        && !receivedResult
        && !sawAuthRequired
        && !(runner?.wasInterrupted ?? false)
      ) {
        const message = code !== 0
          ? `Agent process exited with code ${code}`
          : "Agent process ended without a response";
        if (runner) {
          emitChatCard(
            runner,
            { type: "error", message, sessionId },
            { role: "assistant", text: `Error: ${message}`, isError: true },
            { chatHistoryManager: deps.listenerDeps.chatHistoryManager, sessionId },
          );
        } else {
          emit({ type: "error", message });
        }
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

      // Process exited without ever producing a turn result (the dispatched
      // "first turn never ran" bug, docs/163). Hand off to the dispatch
      // retry/surface hook BEFORE the normal teardown — for BOTH streaming and
      // non-streaming dispatched turns. A child/quick session now runs its first
      // turn as a streaming process (so a follow-up `shipit session message` can
      // steer it, docs/163), and a streaming process can still exit with no
      // result (crash / hook-abort); without firing the hook here the streaming
      // branch below would silently report a *completed* turn, re-masking the bug
      // docs/163 fixed. If the hook claims the turn (retry dispatched or error
      // surfaced) we stop here; the new turn / error path owns drain + commit +
      // finished. WS leaves `onNoResultExit` unset and is unaffected.
      if (
        input.onNoResultExit &&
        !receivedResult &&
        !sawAuthRequired &&
        !(runner?.wasInterrupted ?? false)
      ) {
        const handled = await input.onNoResultExit(code);
        if (handled) return;
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
        // SHI-262 — on that abnormal-exit path `tryDrain` also runs the local
        // auto-commit first when something is queued, so the crashed turn's
        // partial edits are in git before the queued turn (which may reset the
        // working tree) starts.
        //
        // But `tryDrain` commits ONLY when something is queued, which left the
        // ordinary shape of "the agent process died" — crash, OOM kill,
        // SIGTERM from a container restart, with an EMPTY queue — running no
        // commit at all. Everything the turn wrote before it died stayed
        // uncommitted and unpushed until some later turn happened to sweep it up
        // with `git add -A`; if the session was never resumed, or the next turn
        // began by discarding working-tree state, it was simply lost. Streaming
        // is the default whenever live steering is on, so this was the common
        // case, not a corner. Run the same three steps the non-streaming branch
        // below runs, in the same order (finished-SSE → commit/PR → idle, so
        // remediation never starts against a pre-commit tree). Both are
        // first-wins guarded, so the normal path — where `agent_result` already
        // ran the whole post-turn flow and this `done` is just the resident
        // process exiting later — is unchanged: `runCommitAndPr` returns the
        // memoized (already-settled) flow and the two idle signals no-op behind
        // their `running` guards.
        if (runner) runner.running = false;
        await tryDrain();
        broadcastFinishedIfIdle();
        await runCommitAndPr();
        signalIdleIfIdle();
        finishTurn();
        return;
      }

      // Non-streaming: drain first (clears queued visual state before the slow
      // commit), broadcast the finished SSE so other tabs update promptly, then
      // commit/PR, then signal idle (remediation) last. All guarded so a prior
      // agent_result that already drained/synced makes these no-ops — including
      // `runCommitAndPr`, whose `commitOnce` returns the commit `tryDrain`
      // already made when it had a queued turn to start (SHI-262).
      await tryDrain();
      broadcastFinishedIfIdle();
      await runCommitAndPr();
      signalIdleIfIdle();
      // docs/169 — hand control back to a multi-turn driver (rebase loop) and
      // clear the system-turn flag, after all post-turn work has settled.
      finishTurn();
    } finally {
      // No-op whenever a branch above already called `finishTurn()`; the
      // backstop for the ones that returned early.
      settleTurn(turnNoResult(`agent process exited (code ${code}) without settling the turn`));
    }
  });

  // docs/240 — an ADOPTED turn is already running inside the container: the
  // listeners above are the whole job. Skip env-prep and the spawn entirely
  // (re-running `/agent/start` would 409 against the live process, and a
  // `sendUserMessage` would inject a phantom message into the user's turn).
  if (input.adopt) return;

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
    activeResumeSessionId = deps.listenerDeps.sessionManager.get(sessionId)?.agentSessionId ?? null;

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
      // SHI-264 — stamp the delivery onto the spawn BEFORE it starts, so the
      // worker records it with the turn and reports it from `/agent/status`.
      // That report is the only thing that can tell an orchestrator which
      // started AFTER this turn what delivery the surviving turn belongs to.
      if (input.deliveryId !== undefined) agent.setDeliveryId?.(input.deliveryId);
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
