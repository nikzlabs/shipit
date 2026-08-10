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

import type { AgentId, AgentProcess, PermissionMode, AgentEvent, WsServerMessage, SessionInfo, SessionMessageOrigin } from "../shared/types.js";
import { desiredSpawnIdentity } from "./service-routing.js";
import { buildTurnMessages, wireAgentListeners } from "./ws-handlers/agent-listeners.js";
import { createAgentStderrTail } from "./agent-stderr-tail.js";
import {
  detectHardExhaustion,
  detectHardExhaustionInTurnText,
  exhaustionLockoutUntil,
} from "./ws-handlers/agent-rate-limits.js";
import { credentialFailurePolicyForRoute, stopsOnCredentialFailure } from "./credential-failure-policy.js";
import type { CredentialFailurePolicy } from "./credential-failure-policy.js";
import { ProviderRouteUnavailableError } from "./provider-route-preflight.js";

/**
 * docs/260 §3 — one refused attempt in a turn's attempt loop: which credential,
 * what the provider actually said, and when it claims the window resets.
 */
export interface RefusedAttempt {
  routeId: string;
  label: string;
  providerMessage: string;
  resetAt: string | null;
}

/**
 * docs/260 req 6 — the terminal all-refused message, built ONLY from this
 * turn's actual refusals. Ends with what the user can do about it, matching
 * the routing message it replaces — and a resend genuinely re-tries every
 * account (req 12), so the sentence is true by construction.
 */
export function allRefusedMessage(ledger: readonly RefusedAttempt[]): string {
  const lines = ledger.map((entry) => {
    const reset = entry.resetAt ? ` (resets at ${entry.resetAt})` : "";
    return `- ${entry.label}${reset}: ${entry.providerMessage}`;
  });
  return `Every connected account refused this turn for quota:\n${lines.join("\n")}\nSend this message again to re-try every account, or connect another account in Settings.`;
}
import { resetRunnerTurnState } from "./session-runner.js";
import type { SessionRunnerInterface, SystemTurnDeps } from "./session-runner.js";
import { formatUnresolvedConflictNotice } from "./services/conflict-marker-notice.js";
import { formatSecretScanNotice } from "./services/secret-scan-notice.js";
import { sessionAutoCommitAllowed } from "./services/auto-commit-gate.js";
import { emitChatCard, emitNoticeInTurn, emitNoticePostTurn } from "./chat-card-persistence.js";
import { TURN_COMPLETED, turnErrored, turnInterrupted, turnNoResult, type TurnOutcome } from "./turn-settlement.js";
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
   * docs/260 §3 — the attempt ledger: every credential the provider refused
   * during THIS logical turn, in refusal order. Present on attempt-loop
   * re-dispatches, absent on a first attempt. It bounds the loop — each
   * retry's selection excludes every entry, so a credential is attempted at
   * most once per turn — and it is the only material the terminal all-refused
   * message may be built from (req 6: what the provider said, not a
   * deduction).
   */
  attemptLedger?: readonly RefusedAttempt[];
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
   *
   * `stderrDetail` is the redacted, bounded tail of whatever the CLI wrote to
   * stderr this turn (`agent-stderr-tail.ts`), or `undefined` when it wrote
   * nothing. Passed rather than re-derived so the dispatch path's error text can
   * name the cause for the same reason the WS path's row does — an exit code on
   * its own makes every distinct failure read identically.
   */
  onNoResultExit?: (code: number | null, stderrDetail?: string) => Promise<boolean>;
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
   * once across no-result retries" on top of it (planning#262).
   */
  onTurnComplete?: (outcome: TurnOutcome) => void;
  /**
   * planning#266 — durable identity of the server-side DELIVERY this turn runs on
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
  /**
   * planning#318 — a newer spawn took this turn's agent slot (see the `superseded`
   * event on `AgentProcessEvents`). Latched rather than settled inline so the
   * outcome is built by the one `finishTurn` chain below.
   */
  let wasSuperseded = false;
  const settleTurn = (outcome: TurnOutcome): void => {
    if (turnCompleteFired) return;
    turnCompleteFired = true;
    // planning#266 — the delivery stops being live the moment the turn settles, and
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
    //
    // planning#318 — a turn that RAN and was then cut short settles as `interrupted`,
    // not `no-result`. The two look identical from here (no `agent_result` ever
    // arrived) but mean opposite things to a delivery supervisor: `no-result` is
    // "the work never reached anyone, try again", while `interrupted` is "the
    // prompt reached a live agent and a human — or a newer turn — stopped it".
    // Re-delivering the latter is a duplicate notification, not a recovery,
    // which is exactly how a self-merge wake got sent twice from one merge.
    // Two shapes, one meaning:
    //   • `wasSuperseded` — a newer spawn took the agent slot, so this turn's
    //     own terminal event will be ignored as stale (docs/146).
    //   • `runner.wasInterrupted` — the user pressed stop, or the orchestrator
    //     interrupted the CLI to wait on AskUserQuestion / plan approval.
    // The flags are checked in that order because `resetRunnerTurnState` clears
    // `wasInterrupted` when the DISPLACING turn starts, so it is unreliable
    // (already false) by the time a superseded turn unwinds.
    settleTurn(
      agentErrored
        ? turnErrored()
        : receivedResult
          ? TURN_COMPLETED
          : wasSuperseded
            ? turnInterrupted("a newer turn took the agent slot before this one finished")
            : (runner?.wasInterrupted ?? false)
              ? turnInterrupted("the turn was interrupted before it produced a result")
              : turnNoResult("agent process exited without producing a turn result"),
    );
  };

  if (runner) {
    runner.running = true;
    // docs/169 + planning#257 — a system turn suppresses live steering for its whole
    // duration. `dispatch` sets the flag synchronously for a turn it starts from
    // idle; a system turn that was ENQUEUED and drains later never went through
    // that branch, so set it here too (idempotent) — otherwise a wake-turn
    // drained behind a user turn would run steerable, and a message arriving
    // mid-turn would be injected into it. `finishTurn` clears it.
    if (input.systemTurn) runner.systemTurnInProgress = true;
    // planning#266 — publish this turn's delivery for its whole duration. `dispatch`
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

  // Identity of the turn these closures belong to, captured AFTER the reset
  // above bumped it. The `done` handler can fire long after a SUCCESSOR turn
  // took over the runner (the failover pre-check kills the resident process and
  // its late exit unwinds while the new turn is already running env-prep) — at
  // that point the per-turn accumulators and the session's in-progress chat
  // rows belong to the successor, and this turn's teardown must not write
  // through them. Concretely: `onInterruptedTurn` finalizes ALL of the
  // session's in-progress rows from the runner's CURRENT accumulators, so run
  // stale it flips the successor's freshly-recorded cards (the account-failover
  // notice) to `in_progress=0`; the successor's next boundary then re-inserts
  // them from `recordedCards`, and the transcript keeps both copies forever.
  // Re-captured on a self-wake (see `rearmForSelfWokenTurn`): the wake turn
  // runs through THESE same closures, so after `agent-listeners` gave it a
  // fresh epoch the closures adopt it.
  let thisTurnEpoch = runner?.turnEpoch;
  const turnIsCurrent = (): boolean =>
    !runner || thisTurnEpoch === undefined || runner.turnEpoch === thisTurnEpoch;

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
  // Deliberately NOT gated on `automaticRecoveryInProgress`. It is tempting to read
  // "already recovering → return false" as the de-duplication point, but the
  // return value means "will this turn auto-recover", and `false` routes the
  // caller into `surfaceReauth()` — popping a sign-in card in the middle of a
  // recovery that is about to succeed quietly. De-duplication of a repeated
  // `auth_required` belongs to the emitter (`process.ts`, one raise per turn)
  // and to the listener's own turn latch (`agent-auth-handler.ts`), both of
  // which drop the duplicate before it reaches this gate at all.
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
      // docs/260 — the account to heal is the TURN'S OWN capture (set after
      // env-prep), never a session row: the row records no route any more, and
      // the 401 being healed came from the process this capture describes.
      // A RESERVED route stays unhealable here, as before — a bad API key or
      // env token is not something the account refresher owns. No capture at
      // all (tests / local runtime / no routing in play) keeps the
      // provider-wide heal rather than silently disabling recovery.
      if (capturedCredentialRoute?.providerRouteKind === "account") {
        healed = deps.ensureAgentTokenFresh
          ? await deps.ensureAgentTokenFresh(
              agentId, capturedCredentialRoute.providerRouteId, { force: true },
            )
          : false;
      } else if (capturedCredentialRoute) {
        healed = false;
      } else {
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
      await postTurnStep("drain", tryDrain);
      await postTurnStep("commit", runCommitAndPr);
      await postTurnStep("finished", emitFinishedIfIdle);
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
  // Listener registration happens before environment preparation. Failover
  // happens inside that preparation, so the route becomes immutable only
  // after it returns and immediately before this process starts.
  let capturedCredentialRoute:
    | Pick<SessionInfo, "providerRouteKind" | "providerRouteId">
    | undefined;
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

  /**
   * docs/252 phase 5, req 12 — the gate account benching already had and this
   * retry did not.
   *
   * The retry fires on *detected exhaustion*, from the error object or the
   * turn's own text, with no idea what the failing turn was billed to. On a
   * metered key there is nothing to fail over to — `selectRouteForSelection`
   * resolves the same key again — so the turn would be re-run in full against
   * the credential that just refused it, repeating every side effect the first
   * attempt had. Req 12: keys do not fail over; ShipIt stops and says so, which
   * here means letting the turn retire with the provider's own error.
   *
   * docs/260 req 2 — the credential that refused is the TURN'S OWN capture,
   * so ITS billing mode decides. The session row is only the fallback for a
   * turn with no capture (failed before env-prep, tests, local runtime): the
   * row's selection is mutable mid-turn (`set_model`), and its dead
   * `provider_route_*` columns can still carry a pre-260 pin — neither changes
   * which credential just failed.
   */
  const capturedRoutePolicy = (): CredentialFailurePolicy | undefined => {
    const captured = capturedCredentialRoute;
    if (!captured?.providerRouteKind || !captured.providerRouteId) return undefined;
    const profile = deps.routeProfile?.(captured.providerRouteKind, captured.providerRouteId);
    if (!profile) return undefined;
    return credentialFailurePolicyForRoute(agentId, profile.billingMode, profile.serviceId);
  };
  const quotaRetryAllowed = (): boolean => {
    const policy = capturedRoutePolicy();
    if (policy) return !policy.stopsOnFailure;
    return !stopsOnCredentialFailure(deps.listenerDeps.sessionManager.get(sessionId));
  };

  const retryOnNextAccount = async (entry: RefusedAttempt): Promise<void> => {
    console.log(
      `[turn] ${agentId} reported a quota refusal for ${sessionId} on ${entry.routeId}; `
      + "retrying on the next eligible credential",
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
      attemptLedger: [...(input.attemptLedger ?? []), entry],
      reuseExistingAgent: false,
      emitUserEcho: false,
      persistGuard,
    });
  };

  // docs/260 §3 — the ledger entry for a refusal that just happened: the
  // captured route (the credential this attempt actually authenticated with),
  // its user-facing label, the provider's own words, and the lockout end.
  const ledgerEntryFor = (
    providerMessage: string,
    detected: Parameters<typeof exhaustionLockoutUntil>[0],
  ): RefusedAttempt => {
    const routeId = capturedCredentialRoute?.providerRouteId ?? "unknown";
    // docs/260 req 6 — "resets at" only ever quotes the PROVIDER'S OWN stated
    // instant. When it named none, `exhaustionLockoutUntil` synthesizes a
    // short self-expiring lockout for the internal bench stamp — an estimate
    // that must not be presented to the user as a provider-reported reset.
    const statedReset =
      detected.resetAt !== null && !Number.isNaN(Date.parse(detected.resetAt))
        ? new Date(Date.parse(detected.resetAt)).toISOString()
        : null;
    return {
      routeId,
      label: (routeId !== "unknown" ? deps.routeLabel?.(routeId) : undefined) ?? routeId,
      providerMessage: providerMessage.replace(/\s+/g, " ").trim().slice(0, 400),
      resetAt: statedReset,
    };
  };

  /**
   * docs/252 phase 5 — the same failover, reached from an adapter-level `error`.
   *
   * Codex reports a spent subscription by refusing `turn/start`, and a rejected
   * JSON-RPC request becomes an `error` rather than the `agent_result` the
   * branch below watches — so on that path req 14's same-turn failover and
   * req 7's exhaustion stamp both never fired. Verified by reading
   * `codex/adapter.ts` (`initializeAndRun(...).catch(err => emit("error"))`)
   * rather than inferred from Claude's shape.
   *
   * Stamping happens here rather than in `agent-listeners`, which only stamps on
   * `agent_result`: without it the retry would re-select the same spent
   * credential and the hop would be wasted. It is `markSessionAccountExhausted`
   * that decides whether the failing route is stampable at all — a metered key
   * has no window to bench (req 12).
   *
   * Synchronous by contract: the listener needs the answer before it starts
   * tearing the turn down, so the re-dispatch is fired and not awaited.
   *
   * **Returning `true` claims a turn nobody else will finish**, which is what
   * makes both failure modes below load-bearing rather than defensive. The
   * listener has surrendered its terminal cleanup and the dead process's `done`
   * stands down on `quotaRetryInProgress`, so if the retry never happens the turn
   * sits with `running` true, its edits uncommitted and no viewer told anything
   * — CLAUDE.md's "every terminal path runs the commit", broken by a path that
   * looks terminal and is not. So: anything that can throw runs BEFORE the claim
   * and un-claims by returning `false`, and a rejection after the claim runs the
   * same teardown `recoverAuth` runs on a failed heal. Found by cross-backend
   * review.
   */
  const willRetryOnQuotaError = (err: Error): boolean => {
    // A STALE quota error — a successor turn already owns the runner — must not
    // claim anything: the finalize below would flip the successor's rows, the
    // stamp would bench the account the successor is pinned to, and the retry's
    // fresh agent would displace the successor's. The listener checks this
    // before calling; kept here too so no future caller ordering can reopen it.
    if (!turnIsCurrent()) return false;
    // A turn blocked by the router is not a turn that ran out mid-flight — it is
    // req 13 already having decided there is nowhere to go. Retrying would loop.
    if (err instanceof ProviderRouteUnavailableError) return false;
    if (!quotaRetryAllowed()) return false;
    const exhausted = detectHardExhaustion(err.message);
    if (!exhausted) return false;
    const refusedEntry = ledgerEntryFor(err.message, exhausted);
    try {
      deps.listenerDeps.markSessionAccountExhausted?.(
        sessionId,
        exhaustionLockoutUntil(exhausted),
        capturedCredentialRoute?.providerRouteId,
      );
      // Finalize what the first attempt already streamed, BEFORE the retry resets
      // every per-turn accumulator. The `agent_result` path gets this for free —
      // `wireAgentListeners` runs its own handler first and has already persisted
      // and finalized by the time the quota branch is reached — but this gate runs
      // at the TOP of the listener's error handler, ahead of the persistence it is
      // standing the listener down from. Without it a retry that fails before
      // producing output rebuilds history from empty groups and deletes the
      // transcript the user already saw, which is the hazard `recoverAuth`
      // documents one recovery over.
      if (runner) {
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
    } catch (prepErr) {
      // Nothing has been claimed yet, so the cheapest correct answer is to let
      // the listener finish the turn exactly as it would have without us.
      console.error("[turn] quota-retry preparation failed; leaving the turn to the error path:", prepErr);
      return false;
    }
    quotaRetryInProgress = true;
    // Fire-and-forget: the listener's gate is synchronous, so the re-dispatch
    // cannot be awaited here.
    void retryOnNextAccount(refusedEntry).catch(async (retryErr: unknown) => {
      console.error("[turn] quota retry from the error path failed:", retryErr);
      // The claim is now a lie — run the teardown the listener would have.
      if (runner) runner.running = false;
      await postTurnStep("drain", tryDrain);
      await postTurnStep("commit", runCommitAndPr);
      await postTurnStep("finished", emitFinishedIfIdle);
      finishTurn();
    });
    return true;
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
    getCapturedRouteId: () => capturedCredentialRoute?.providerRouteId,
    getCapturedRouteKind: () => capturedCredentialRoute?.providerRouteKind,
    // docs/260 req 2 — failure policy resolved from the captured route (see
    // `capturedRoutePolicy`); the auth handler falls back to the session's
    // selection when this answers undefined.
    getCapturedRoutePolicy: capturedRoutePolicy,
    // docs/179 — auto-recovery hooks: the listener calls `willRecoverAuth`
    // synchronously to decide whether to suppress the sign-in card, then
    // `recoverAuth` to heal + re-dispatch. Omitted when this turn can't recover
    // (already a retry, or no healer) so the listener keeps the legacy flow.
    ...(canRecoverAuth ? { willRecoverAuth, recoverAuth } : {}),
    // docs/252 phase 5 — the adapter-`error` twin of the `agent_result` quota
    // branch below. Wired on every attempt: the loop is bounded by the
    // ledger's exclusion set (one attempt per credential), not by hop count.
    willRetryOnQuotaError,
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
    // nothing. Ordered after the drain for the planning#264 reason: with a queue,
    // `tryDrain` has already committed and this reuses that commit; with none,
    // `drainNext` starts nothing, so no later turn's edits can be swept into
    // this turn's commit.
    onError: async () => {
      agentErrored = true;
      finishTurn();
      await postTurnStep("drain", tryDrain);
      await postTurnStep("commit", runCommitAndPr);
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

  /**
   * planning#279 — run ONE step of a turn's terminal sequence so that its failure
   * cannot skip the steps after it. Above all: it cannot skip the commit.
   *
   * `7f6aeb85` made `runCommitAndPr` REACHABLE from every terminal path. It did
   * not make it UNSKIPPABLE on those paths, and on all four it is sequenced
   * LAST — behind the token sync-back, the queue drain, the no-result chat row,
   * the interrupted-turn finalize and the finished-SSE broadcast:
   *
   *     trySyncToken(); await tryDrain(); broadcastFinishedIfIdle(); await runCommitAndPr();
   *
   * Every one of those touches something that throws in the field — SQLite (the
   * WS adapter already catches a literal `"database connection is not open"`
   * from the same manager), the credentials tree, a viewer transport. They run
   * inside an un-awaited `async` event listener, so a throw becomes an unhandled
   * rejection: the remaining statements are abandoned silently, with no error
   * shown to anyone.
   *
   * That is unrecoverable in a way the other steps are not. By the time the
   * commit is skipped, `agent-listeners` has already persisted the transcript,
   * cleared `running` and told every viewer the turn finished, so nothing looks
   * wrong and nothing runs again: the resident streaming process does not exit,
   * so `done` never fires, and the runner's `verifyRunningState` reconciler only
   * acts while `running` is still true. The turn's edits simply stay in the
   * working tree — with no reflog entry — until a later turn's `git add -A`
   * happens to sweep them up under the WRONG summary, or the branch's pull
   * request merges first and ships without them (which is exactly what
   * happened to PR #1890: the work landed 65s after the squash, under the next
   * turn's message, and had to be recovered by a second PR).
   *
   * So: no step of a terminal sequence may prevent a later one. A failure is
   * logged and the sequence continues. The ORDER is unchanged and still
   * load-bearing (planning#264 drain-after-commit, finished-SSE before the commit,
   * the runner "idle" signal after it) — this only removes the implicit
   * "…if everything before it succeeded".
   */
  const postTurnStep = async (label: string, run: () => void | Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (err) {
      console.error(`[turn] post-turn step "${label}" failed for ${sessionId} (continuing):`, err);
    }
  };

  // An auth-required turn legitimately ends without an `agent_result` — the
  // listener already wrote a visible row and kicked off the OAuth flow, so it
  // must NOT trip the no-result retry/surface path below (which would re-run a
  // turn that can only fail auth again).
  let sawAuthRequired = false;
  agent.on("auth_required", () => { sawAuthRequired = true; });

  // Keep the tail of whatever the agent CLI wrote to stderr this turn, so a
  // process that dies before producing an `agent_result` can say WHY in the
  // transcript instead of only reporting its exit code.
  //
  // The reason has always been captured — both adapters forward stderr as a
  // `log` event — but `log` is routed to the Logs panel and the durable
  // `logs/agent.jsonl`, neither of which is the transcript. The persisted chat
  // row is the artifact the user still has after a reload, and it carried only
  // `Agent process exited with code 1`. That is how a Codex cold-start failure
  // (`failed to initialize sqlite state runtime under <dir>`) reached
  // the user as an unexplained dead turn.
  //
  // Listening here rather than in `wireAgentListeners` keeps this next to the
  // `done` handler that consumes it, and works for both runtimes: a
  // containerized turn's stderr arrives over SSE as the same `log` event
  // (`container-session-runner.ts` re-emits it onto the proxy agent).
  const stderrTail = createAgentStderrTail();
  agent.on("log", (source: string, text: string) => { stderrTail.record(source, text); });

  // planning#318 — a newer spawn took this turn's agent slot. SETTLE ONLY: the turn
  // that displaced this one owns the runner, the `_agent` slot and the working
  // tree, so this one must not clear `running`, drain the queue, broadcast a
  // finished-SSE or run a post-turn commit — doing any of that alongside a live
  // turn is precisely the interference the docs/146 stale-spawn guard exists to
  // prevent (and the displacing turn's own `git add -A` sweeps the tree anyway).
  // What it MUST do is stop pretending to be pending: an unsettled system turn
  // strands `systemTurnInProgress` (suppressing live steering for the rest of
  // the session) and, for a wake-turn, strands its merge-watch at
  // `merge-observed` where the retry supervisor re-delivers it.
  agent.on("superseded", () => {
    // docs/179 / docs/260 §3 — stand down when the displacement IS this turn's
    // own recovery: the auth heal and the quota attempt loop replace the dying
    // process on purpose (`runner.setAgent(freshAgent)` in `recoverAuth` /
    // `retryOnNextAccount`) and the re-dispatched attempt owns settlement,
    // exactly as the `done` handler already stands down on both flags. Worse
    // than settling early: a quota-refused attempt has `receivedResult` true
    // (the refusal arrived as its `agent_result`), so `finishTurn` here would
    // settle the logical turn as COMPLETED — telling a multi-turn driver (the
    // rebase conflict loop) that work the agent never did is done, which
    // staged, continued and force-pushed unresolved conflict markers.
    if (automaticRecoveryInProgress || quotaRetryInProgress) return;
    wasSuperseded = true;
    finishTurn();
  });

  let tokenSyncFired = false;
  const trySyncToken = (): void => {
    if (tokenSyncFired) return;
    tokenSyncFired = true;
    deps.finalizeAgentEnv?.(sessionId, agentId, capturedCredentialRoute);
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
    // planning#264 — the finished turn's edits MUST be in git before a queued turn
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
      // Fallback for minimal test setups that wire `autoCommit` but not
      // `commitTurn`. Both production paths (`agent-execution.ts` and
      // `runner-registry-factory.ts`) wire `commitTurn` → `postTurnCommit`, which
      // is where the planning#317 banner state + remediation turn live; this path
      // keeps the notice only, and deliberately has no `sessionManager` to
      // persist block state into.
      //
      // docs/128 / docs/211 — but it must not become the hole around the
      // auto-commit gate: `postTurnCommit` refuses ops/sandbox at its top, and
      // this fallback reaches `git.autoCommit` without going through it. Gated
      // HERE, at the one call site, rather than inside the two identical
      // `SystemTurnDeps.autoCommit` wirings (`agent-execution.ts` and
      // `runner-registry-factory.ts`) — one check instead of two.
      if (!sessionAutoCommitAllowed(deps.listenerDeps.sessionManager, sessionId)) return null;
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
   * planning#264 — run the local auto-commit at most once per turn, whichever path
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
  // planning#264 caveat: when a message IS queued, `tryDrain` commits before starting
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
  // planning#264 — note that the non-streaming branch drains HERE, at `agent_result`,
  // while its commit runs later in `done`. Reordering the two statements in the
  // `done` handler would therefore have fixed nothing; the guarantee has to live
  // inside `tryDrain`, which is the one point every drain path goes through.
  let streamingPostTurnFired = false;
  /**
   * planning#249 — the streaming post-turn sequence currently in flight, assigned in
   * the SAME synchronous block that sets `streamingPostTurnFired`. Anyone who
   * observes that flag as `true` therefore also observes this promise, which is
   * what lets `rearmForSelfWokenTurn` wait the finished turn's flow out before
   * clearing its memoized commit promises.
   */
  let streamingPostTurn: Promise<void> | null = null;

  /**
   * planning#249 — hand the guards back to a turn the CLI started on its own.
   *
   * A `Bash(run_in_background)` job finishing re-invokes the model, and for a
   * resident streaming process that self-woken turn runs through THIS closure —
   * the one the finished user turn left attached (listeners are removed only at
   * the start of the next orchestrator-initiated turn). Every post-turn guard
   * here is first-wins and scoped to one `executeAgentTurn` call, so the wake
   * turn's `agent_result` hit `streamingPostTurnFired` and returned early:
   * no token sync-back, no queue drain, no auto-commit, no push, no PR card.
   * Production saw two sessions lose a 15-minute `shipit agent run` consult's
   * edits to this in one hour, and ShipIt's own guidance tells agents to
   * background that consult — so the wake path is the NORMAL case for
   * cross-agent review, not a corner. docs/235 §6 deferred this deliberately;
   * this is that follow-up.
   *
   * Three things make it safe to re-arm here:
   *
   *   - **Streaming only.** With live steering off the CLI is a one-shot PTY
   *     that reaps its background tasks at turn end and exits (docs/235 probe
   *     A), so there is no resident process to wake and nothing to re-arm. It
   *     also matters that we DON'T: the non-streaming turn drains at
   *     `agent_result` and commits later in `done`, so clearing `drainFired`
   *     between the two would let `done` drain the queue a second time.
   *
   *   - **Only after this turn's own post-turn flow fired.** `agent_self_wake`
   *     rides the CLI's `task_notification`, which ALSO fires for a background
   *     job started earlier in the CURRENT turn and reporting back mid-stream —
   *     the docs/237 trap that `agent-listeners` guards with `!runner.running`
   *     (`self-wake-midturn.test.ts`). We cannot reuse that test: `agent-listeners`
   *     is wired first and has already flipped `running` to true by the time this
   *     listener runs. `streamingPostTurnFired` is the executor-local equivalent
   *     — it is set only by this turn's `agent_result` — so `false` means the
   *     turn that owns these guards is still in flight and a re-arm would let a
   *     duplicate `agent_result` run the whole post-turn flow twice.
   *
   *   - **After the in-flight sequence settles.** The wake can land in the
   *     window between `streamingPostTurnFired = true` and the finished turn's
   *     `runCommitAndPr` — a job backgrounded just before the turn ended, with
   *     the PR round-trip still running, is an ordinary shape. Nulling
   *     `commitAndPrPromise` there would let the finished turn's flow re-memoize
   *     it a moment later, and the wake turn would then get that already-settled
   *     flow back and commit nothing: the same bug, one window narrower.
   *
   * `receivedResult` is deliberately NOT reset. It describes the turn this
   * executor was invoked for, which genuinely produced a result; clearing it
   * would arm the no-result paths in `done` (the "ended without a response"
   * error row, `onInterruptedTurn`, and — worst — dispatch's `onNoResultExit`,
   * which would re-run the user's original prompt) if the wake turn's process
   * later died. Same for `turnCompleteFired`: the wake turn is not the turn a
   * dispatch handle is waiting on, so it must not settle it a second time.
   */
  const rearmForSelfWokenTurn = async (): Promise<void> => {
    if (!useStreaming || !streamingPostTurnFired) return;
    await postTurnStep("await-post-turn", () => streamingPostTurn ?? Promise.resolve());
    // A second wake can arrive while we await; the first one through re-arms and
    // the rest see the cleared flag and stand down.
    if (!streamingPostTurnFired) return;
    console.log(`[turn] self-wake for ${sessionId}; re-arming the post-turn flow`);
    tokenSyncFired = false;
    drainFired = false;
    streamingPostTurnFired = false;
    streamingPostTurn = null;
    commitPromise = null;
    commitAndPrPromise = null;
    // The wake turn now owns these closures. `agent-listeners` already gave it
    // a fresh epoch (its `agent_self_wake` branch runs `resetRunnerTurnState`
    // before this listener fires); adopt it so the wake turn's own teardown —
    // e.g. `onInterruptedTurn` after a crash — is not mistaken for a stale
    // predecessor's.
    thisTurnEpoch = runner?.turnEpoch;
  };

  agent.on("event", async (event: AgentEvent) => {
    // planning#249 — the CLI is starting a turn nobody asked it for. `agent-listeners`
    // has already given it a clean accumulator and marked the runner running
    // (docs/235 §6); this gives it a post-turn flow to end on.
    if (event.type === "agent_self_wake") {
      await rearmForSelfWokenTurn();
      return;
    }
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
    //
    // …and when there is no error at all, the turn's final assistant text. A
    // Claude CLI that hits the limit mid-turn reports it as an ordinary
    // assistant message and ends `subtype: "success"`, so gating the retry on
    // `event.error` alone made that shape — the one production actually hit —
    // structurally invisible. `turnSummary` is this turn's own (it is cleared
    // by `resetRunnerTurnState` at turn start) and is already populated:
    // `wireAgentListeners` runs first and assigns it from `agent_assistant`.
    if (quotaRetryAllowed()) {
      const exhausted = event.error
        ? detectHardExhaustion(event.error)
        : detectHardExhaustionInTurnText(runner?.turnSummary);
      if (exhausted) {
        quotaRetryInProgress = true;
        await retryOnNextAccount(
          ledgerEntryFor(event.error ?? runner?.turnSummary ?? "quota exhausted", exhausted),
        );
        return;
      }
    }
    if (useStreaming) {
      if (streamingPostTurnFired) return;
      streamingPostTurnFired = true;
      // planning#279 — every step runs through `postTurnStep`, so a throw in the
      // token sync-back, the drain or the finished-SSE broadcast can no longer
      // abandon the rest of the sequence (and with it the commit). This is the
      // path the ordinary streaming turn ends on, so it is the one that
      // silently dropped a completed turn's work.
      //
      // planning#249 — published as `streamingPostTurn` in this same synchronous
      // block so a self-wake landing mid-flow waits it out before re-arming
      // (see `rearmForSelfWokenTurn`). The sequence and its order are unchanged.
      streamingPostTurn = (async () => {
        await postTurnStep("token-sync", trySyncToken);
        // agent-listeners already set running=false; the resident process is NOT
        // cleared (the next top-level turn reuses it via reuseExistingAgent).
        // Drain through the guarded `tryDrain` (not `input.drainNext` directly)
        // so the streaming `done` handler's drain — added for the abnormal-exit
        // case below — can't double-drain after this normal end-of-turn drain.
        await postTurnStep("drain", tryDrain);
        await postTurnStep("finished-sse", broadcastFinishedIfIdle);
        await postTurnStep("commit", runCommitAndPr);
        await postTurnStep("idle", signalIdleIfIdle);
      })();
      await streamingPostTurn;
    } else {
      await postTurnStep("token-sync", trySyncToken);
      await postTurnStep("drain", tryDrain);
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
    // `finishTurn`, which is exactly how planning#262's callback ended up firing zero
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
          // and blocking idle reclaim forever. planning#246 — this also announces
          // the marker, so a process that exits without a draining event still
          // clears the sidebar dot; it re-states the UNION, so a consult that
          // outlived this turn keeps its half of it.
          runner.clearBackgroundTasks();
        }
      }

      // A STALE, result-less exit stands down entirely. `!turnIsCurrent()`
      // means a SUCCESSOR turn owns the runner, so every remaining step — the
      // token sync-back, the no-result row, the partial finalize, the dispatch
      // no-result hook (which would re-run this turn's prompt beside the live
      // one), `running = false`, the queue drain, the finished-SSE, the commit
      // and the idle signal — now belongs to that successor and running any of
      // them here is interference (the double-failover-notice incident; see
      // `turnIsCurrent`). This covers the exits the docs/146 SSE relay guard
      // never sees: a RUNTIME_MODE=local child process, or a proxy event
      // emitted locally. The `finally` below still settles the superseded turn
      // (planning#318 — usually a no-op after the `superseded` event already did).
      //
      // Deliberately conditioned on `!receivedResult`: a COMPLETED turn's late
      // `done` legitimately lands after its own drain started the next queued
      // turn (which bumps the epoch) and must still run its memoized commit/PR
      // flow. `receivedResult` is what separates "finished turn, late exit"
      // from "killed mid-flight, superseded".
      if (!receivedResult && !turnIsCurrent()) {
        console.warn(
          `[turn] stale exit (code ${code}) for ${sessionId} ignored — a newer turn owns the session`,
        );
        return;
      }

      // Non-streaming captures the token here too (fallback if agent_result was
      // lost); streaming already synced in the agent_result block. planning#279 —
      // guarded: a credentials-tree failure here must not skip the commit far
      // below.
      if (!useStreaming) await postTurnStep("token-sync", trySyncToken);

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
        const base = code !== 0
          ? `Agent process exited with code ${code}`
          : "Agent process ended without a response";
        // Append the CLI's own last words when it left any. This row is the
        // whole user-visible outcome of a turn that produced nothing, so the
        // exit code alone makes every distinct failure look identical — a bad
        // `--resume`, a missing binary, and a Codex cold-start collision all
        // read as "exited with code 1". Redacted + bounded by the tail itself.
        const detail = stderrTail.describe();
        const message = detail ? `${base}: ${detail}` : base;
        // planning#279 — this writes a chat row; a SQLite failure here must not skip
        // the commit below (a dead turn's partial edits are the whole reason
        // this path commits at all).
        await postTurnStep("no-result-row", () => {
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
        // planning#279 — guarded for the same reason as the row above: it rewrites
        // chat-history rows, and its failure must not cost the turn its commit.
        await postTurnStep("finalize-partial-turn", () => input.onInterruptedTurn?.());
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
        // planning#279 — a hook that THROWS has not claimed the turn, so fall
        // through to the normal teardown (which commits) rather than
        // abandoning the sequence. Only a clean `true` hands the turn over.
        let handled = false;
        await postTurnStep("no-result-exit-hook", async () => {
          handled = await input.onNoResultExit!(code, stderrTail.describe());
        });
        if (handled) return;
      }

      // Structural counterpart of `onInterruptedTurn` for turns whose caller
      // supplied none (prod incident 2026-08-09, session 468191f5): a
      // dispatched/steered turn whose process was SIGTERMed mid-turn reached
      // this point with NOTHING finalizing its streamed rows when the
      // no-result hook stood down (`wasInterrupted` true — e.g. an interrupt
      // the resident process outlived) or threw. Those rows stayed
      // `in_progress=1`, so the NEXT turn's `replaceInProgress()` deleted them
      // — the user watched the turn's messages vanish on reload. Finalize here
      // whenever no caller hook did, so a turn that dies without an
      // `agent_result` can never leave rows behind for a later turn to sweep
      // away. Three stand-downs: a SUPERSEDED turn's accumulator now belongs
      // to the newer turn (rebuilding history from it would clobber that
      // turn's live rows); a non-null agent slot means another turn is already
      // live on this runner for the same reason; and an ERRORED turn was
      // already finalized by the `error` listener (`agent-listeners.ts`),
      // which leaves the accumulator populated — an adapter can emit `error`
      // and then `done`, and re-running `replaceInProgress` here after the
      // rows were finalized would append a duplicate copy of the turn.
      if (
        !receivedResult
        && !sawAuthRequired
        && !agentErrored
        && !input.onInterruptedTurn
        && !wasSuperseded
        && runner !== null
        && runner.getAgent() === null
      ) {
        // planning#279 — guarded like every other step: this rewrites chat-history
        // rows, and its failure must not cost the turn its commit below.
        await postTurnStep("finalize-partial-turn-fallback", () => {
          const partial = buildTurnMessages(
            runner.chatMessageGroups,
            runner.steeredMessages ?? [],
            runner.recordedCards ?? [],
            { inProgress: false },
          );
          deps.listenerDeps.chatHistoryManager.replaceInProgress(sessionId, partial);
          deps.listenerDeps.chatHistoryManager.finalizeInProgress(sessionId);
          // Mirrors `onInterruptedTurn` (docs/163): the finalized turn must not
          // be replayed on top of its persisted copy by a later WS reconnect.
          runner.clearTurnEventBuffer();
        });
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
        // planning#264 — on that abnormal-exit path `tryDrain` also runs the local
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
        await postTurnStep("drain", tryDrain);
        await postTurnStep("finished-sse", broadcastFinishedIfIdle);
        await postTurnStep("commit", runCommitAndPr);
        await postTurnStep("idle", signalIdleIfIdle);
        finishTurn();
        return;
      }

      // Non-streaming: drain first (clears queued visual state before the slow
      // commit), broadcast the finished SSE so other tabs update promptly, then
      // commit/PR, then signal idle (remediation) last. All guarded so a prior
      // agent_result that already drained/synced makes these no-ops — including
      // `runCommitAndPr`, whose `commitOnce` returns the commit `tryDrain`
      // already made when it had a queued turn to start (planning#264).
      await postTurnStep("drain", tryDrain);
      await postTurnStep("finished-sse", broadcastFinishedIfIdle);
      await postTurnStep("commit", runCommitAndPr);
      await postTurnStep("idle", signalIdleIfIdle);
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
  //
  // docs/260 §5 — its route capture comes from the recovered resident identity
  // (`turn-adoption.ts` restores it from the account marker), so refusals,
  // rate-limit events, and write-back from the surviving process attribute to
  // the account it actually runs on.
  if (input.adopt) {
    const resident = runner?.residentRoute;
    capturedCredentialRoute = resident
      ? { providerRouteKind: resident.kind, providerRouteId: resident.id }
      : undefined;
    return;
  }

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
    //
    // `reusingResidentAgent` is the one thing env-prep cannot work out for
    // itself, and it decides whether the docs/153 leak repair may run: the
    // repair rewrites the very subtree a resident CLI is reading from, which
    // is how a mid-session turn came back `Not logged in · Please run /login`
    // (nikzlabs/shipit#1874). Credential *topology* changes only at a spawn
    // boundary; the token copy still happens either way.
    const envBegan = Date.now();
    const prep = await deps.prepareAgentEnv?.(sessionId, agentId, {
      reusingResidentAgent: input.reuseExistingAgent === true,
      // docs/260 §3 — a credential the provider refused this turn is out of
      // the running; selection may not hand it back.
      ...(input.attemptLedger?.length
        ? { excludeRouteIds: input.attemptLedger.map((entry) => entry.routeId) }
        : {}),
      // docs/260 reqs 8/13 — the resident process's credential prefers to keep
      // serving this session under `balanced`, and MUST keep it when the
      // process is being reused (its token is in memory) or holds background
      // work (killing it would lose the tokens already spent — req 13).
      ...(runner?.residentRoute ? { residentRoute: runner.residentRoute } : {}),
      requireResidentRoute:
        runner?.residentRoute !== undefined
        && (input.reuseExistingAgent === true
          || (runner?.backgroundWorkDescriptions.length ?? 0) > 0),
    });
    console.log(`[turn] env-prep for ${sessionId} took ${Date.now() - envBegan}ms`);
    const preparedSession = deps.listenerDeps.sessionManager.get(sessionId);
    activeResumeSessionId = preparedSession?.agentSessionId ?? null;
    const turnRoute = prep?.turnRoute;
    capturedCredentialRoute = turnRoute
      ? { providerRouteKind: turnRoute.kind, providerRouteId: turnRoute.id }
      : undefined;
    // docs/260 req 10 — say the account in the transcript when it changed:
    // after a refusal ("X is out of quota — continuing on Y"), and between
    // turns when routing moved the session ("Continuing on Y"). Labels are the
    // user's own; both notices ride the in-turn persisted path.
    const lastRefusal = input.attemptLedger?.at(-1);
    if (runner && turnRoute) {
      const routeLabel = deps.routeLabel?.(turnRoute.id) ?? turnRoute.id;
      if (lastRefusal) {
        emitNoticeInTurn(
          runner,
          sessionId,
          `${lastRefusal.label} is out of quota — continuing this turn on ${routeLabel}.`,
          deps.listenerDeps.chatHistoryManager,
        );
      } else {
        const previousRouteId = deps.listenerDeps.usageManager?.lastTurnCredentialRouteId?.(sessionId);
        if (previousRouteId !== undefined && previousRouteId !== turnRoute.id) {
          emitNoticeInTurn(
            runner,
            sessionId,
            `Continuing on ${routeLabel}.`,
            deps.listenerDeps.chatHistoryManager,
          );
        }
      }
    }

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
      // planning#266 — stamp the delivery onto the spawn BEFORE it starts, so the
      // worker records it with the turn and reports it from `/agent/status`.
      // That report is the only thing that can tell an orchestrator which
      // started AFTER this turn what delivery the surviving turn belongs to.
      if (input.deliveryId !== undefined) agent.setDeliveryId?.(input.deliveryId);
      const paramsBegan = Date.now();
      const runParams = await deps.buildRunParams(sessionId, agentId, prompt, turnRoute);
      console.log(`[turn] build-run-params for ${sessionId} took ${Date.now() - paramsBegan}ms; spawning agent`);
      // WS always carries `useStreaming` (true or false); dispatch leaves it
      // undefined so the run params are unchanged from the system-turn shape.
      agent.run(input.useStreaming !== undefined ? { ...runParams, useStreaming: input.useStreaming } : runParams);
      if (runner) runner.appliedPermissionMode = input.permissionMode;
      // Record what this process was actually spawned AS — model, service,
      // billing mode, style, endpoint and credential route. The next turn
      // compares its own against this to decide whether the resident process can
      // be reused (`resident-spawn-guard.ts`); without it a mid-session change
      // is silently a no-op under live steering.
      //
      // Derived from the session row rather than from `runParams`, deliberately:
      // the guard asks the same function of the same row, so the two agree by
      // construction. Two derivations of "the same" tuple is how a spurious
      // respawn on every turn gets built.
      if (runner) {
        runner.appliedSpawnIdentity = desiredSpawnIdentity(
          deps.listenerDeps.sessionManager,
          sessionId,
          agentId,
        );
        // docs/260 §5 — the resident process's credential identity, typed
        // runner state: what the next turn's pre-capture release check, the
        // req-13 guard, and disconnect enumeration read.
        runner.residentRoute = turnRoute ? { kind: turnRoute.kind, id: turnRoute.id } : undefined;
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    // docs/260 req 6 — when the attempt loop ran out of candidates, the
    // routing throw is generic while this turn holds the actual refusals.
    // Replace the message with the ledger: each attempted credential, what
    // the provider answered, and when it resets. Still the same error class,
    // so the listener's blocked-turn path (no retry, verbatim surface) holds.
    if (error instanceof ProviderRouteUnavailableError && input.attemptLedger?.length) {
      error.message = allRefusedMessage(input.attemptLedger);
    }
    agent.emit("error", error);
  }
}
