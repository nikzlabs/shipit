import type { AgentId, AgentProcess, PermissionMode, AgentEvent, WsServerMessage, SessionInfo, SessionMessageOrigin } from "../shared/types.js";
import { desiredSpawnIdentity } from "./service-routing.js";
import { buildTurnMessages, wireAgentListeners } from "./ws-handlers/agent-listeners.js";
import { createAgentStderrTail } from "./agent-stderr-tail.js";
import {
  detectHardExhaustion,
  detectHardExhaustionInTurnText,
  exhaustionLockoutUntil,
} from "./ws-handlers/agent-rate-limits.js";
import { credentialFailurePolicyForRoute, quotaRefusalCanFailOver } from "./credential-failure-policy.js";
import type { CredentialFailurePolicy } from "./credential-failure-policy.js";
import { ProviderRouteUnavailableError } from "./provider-route-preflight.js";

export interface RefusedAttempt {
  routeId: string;
  label: string;
  providerMessage: string;
  resetAt: string | null;
  failureKind: "quota" | "auth";
}

export function allRefusedMessage(ledger: readonly RefusedAttempt[]): string {
  const quotaAttempts = ledger.filter((entry) => entry.failureKind === "quota");
  const authAttempts = ledger.filter((entry) => entry.failureKind === "auth");
  const lines = quotaAttempts.map((entry) => {
    const reset = entry.resetAt ? ` (resets at ${entry.resetAt})` : "";
    return `- ${entry.label}${reset}: ${entry.providerMessage}`;
  });
  if (authAttempts.length === 0) {
    return `Every connected account refused this turn for quota:\n${lines.join("\n")}\nSend this message again to re-try every account, or connect another account in Settings.`;
  }
  const quotaSection = lines.length > 0
    ? `Quota refusals:\n${lines.join("\n")}\n`
    : "";
  const authSection = authAttempts.length > 0
    ? `Authentication failed for: ${authAttempts.map((entry) => entry.label).join(", ")}.\n`
    : "";
  return `${quotaSection}${authSection}No eligible subscription account could continue this turn. Sign in again or connect another account in Settings, then resend your message.`;
}
import { resetRunnerTurnState } from "./session-runner.js";
import { prepareDispatch } from "./prepared-dispatch.js";
import {
  clearConversationThread,
  markSessionStatusStale,
  shouldNudgeForStatusCard,
  statusNudgePrompt,
  type SessionStatusDeps,
  type TurnStatusFacts,
} from "./services/session-status.js";
import { releaseQueuedTurn } from "./queue-drain.js";
import { systemTurnBlockedByResidentWork } from "./turn-admission.js";
import type { SessionRunnerInterface, SystemTurnDeps } from "./session-runner.js";
import { formatUnresolvedConflictNotice } from "./services/conflict-marker-notice.js";
import { formatSecretScanNotice } from "./services/secret-scan-notice.js";
import { formatUnreadableWorkspaceNotice } from "./services/unreadable-workspace-notice.js";
import { sessionAutoCommitAllowed } from "./services/auto-commit-gate.js";
import { emitChatCard, emitNoticeInTurn, emitNoticePostTurn } from "./chat-card-persistence.js";
import { TURN_COMPLETED, resultIsTheAgentsOwn, turnErrored, turnInterrupted, turnNoResult, type NoticeDelivery, type TurnOutcome } from "./turn-settlement.js";
import type { AgentInterfaceProvenance } from "../shared/agent-interface-sdk/protocol.js";
import { getAgentCapabilities } from "../shared/agent-registry.js";

export interface TurnInput {
  agentId: AgentId;
  sessionId: string;
  prompt: string;
  userText: string;
  agentInterface?: AgentInterfaceProvenance;
  messageOrigin?: SessionMessageOrigin;
  activity?: string;
  permissionMode?: PermissionMode;
  // Queue drains already restore the bubble through queue_updated.dequeued.
  emitUserEcho: boolean;
  userEcho?: {
    clientRequestId?: string;
    images?: { data?: string; mediaType: string; src?: string }[];
    files?: { path: string; contentPreview: string; startLine?: number; endLine?: number }[];
    uploadPaths?: string[];
    userReview?: { filePaths: string[]; commentCount: number };
  };
  persistUserMessage: (sessionId: string) => void;
  afterUserMessagePersisted?: (sessionId: string) => void;
  isNewSession: boolean;
  isAuthRetry?: boolean;
  recoveryRetryUsed?: boolean;
  // Retries exclude every recorded route; use only actual provider refusals.
  attemptLedger?: readonly RefusedAttempt[];
  persistGuard?: { done: boolean };
  fallbackTitle: string;
  // Initial turn only. Adopted turns resample into the executor's mutable value.
  turnStartHeadHash: string | null;
  readTurnStartHeadHash?: () => Promise<string | null>;
  /** ownsSystemHold is false once another owner has taken the hold this turn started with. */
  drainNext: (info?: { ownsSystemHold: boolean }) => Promise<void>;
  emit: (msg: WsServerMessage) => void;
  useStreaming?: boolean;
  reuseExistingAgent?: boolean;
  emitErrorOnNoResult?: boolean;
  onInterruptedTurn?: () => void;
  // true transfers terminal work to the hook/retry; false keeps normal teardown.
  onNoResultExit?: (code: number | null, stderrDetail?: string) => Promise<boolean>;
  // "none" leaves commit, push, PR and queue drain to the multi-turn driver.
  postTurn?: "commit-push" | "none";
  systemTurn?: boolean;
  onTurnComplete?: (outcome: TurnOutcome) => void;
  /**
   * Receipts for notices already built into `prompt`, acknowledged only once the
   * agent has produced a real result for it (docs/299-agent-settings-access
   * req 8). A retry carries them onto its successor, so only the attempt that
   * actually ran acknowledges.
   */
  noticeDeliveries?: readonly NoticeDelivery[];
  deliveryId?: string;
  adopt?: boolean;
  compact?: boolean;
  /** ShipIt's own turn, with no user row of its own: today, compaction. */
  silent?: boolean;
  /** docs/303 req 15 — this turn IS the status nudge, so it is never nudged again. */
  statusNudge?: boolean;
}

export async function executeAgentTurn(
  runner: SessionRunnerInterface | null,
  deps: SystemTurnDeps,
  agent: AgentProcess,
  input: TurnInput,
): Promise<void> {
  const { agentId, prompt, activity, sessionId, emit } = input;
  deps.listenerDeps.sessionManager.track(sessionId);
  if (deps.listenerDeps.sessionManager.setMuted(sessionId, null)) {
    deps.listenerDeps.sseBroadcast("session_list", {
      sessions: deps.listenerDeps.sessionManager.list(),
    });
  }
  const useStreaming = input.useStreaming ?? false;
  // Streaming alone is insufficient: some adapters emit final text after ending their process.
  const adoptsCliStartedTurns = useStreaming && (getAgentCapabilities(agentId)?.startsOwnTurns ?? false);
  const postTurn = input.postTurn ?? "commit-push";

  let agentErrored = false;
  let turnCompleteFired = false;
  let wasSuperseded = false;

  // Arm after PR/release pushes, preventing a plain push racing their force-push.
  let pendingPushArm: (() => void) | null = null;
  const armPendingPush = (): void => {
    const arm = pendingPushArm;
    pendingPushArm = null;
    if (!arm) return;
    try {
      arm();
    } catch (err) {
      console.error("[turn] arming the post-turn auto-push failed:", err);
    }
  };

  /*
    Which turn a result answers, recorded as each turn begins rather than
    inferred from what the result looks like (docs/299-agent-settings-access
    req 8). `agent_result` carries no identity of its own and a resident CLI
    starts turns ShipIt composed no prompt for, so "the prompt was submitted and
    the result looks like the agent's own work" is true of a result that ends
    someone else's turn.

    This prompt has exactly one turn, so its four states are a lifecycle and not
    flags: "queued" and "running" are both awaiting a result and differ in the
    one thing a wake has to ask — whether the CLI is inside THIS turn right now —
    and "ended" is terminal, so a confirmation that lands after the result cannot
    put the prompt back in flight.
  */
  let ownTurn: "unsubmitted" | "queued" | "running" | "ended" = "unsubmitted";
  let cliTurnPending = false;

  // Submitting makes this prompt the running turn, unless the CLI is in one of
  // its own: then it waits behind that, and a result is owed to that turn first.
  const noteSubmissionAccepted = (): void => {
    if (ownTurn !== "unsubmitted") return;
    ownTurn = cliTurnPending ? "queued" : "running";
  };

  const noteSubmitted = (): void => {
    const settled = agent.submissionSettled?.();
    // A synchronous submission has landed when the call returns; a proxied one
    // has not, and a resident CLI can finish a turn of its own in that window.
    if (!settled) {
      noteSubmissionAccepted();
      return;
    }
    void (async () => {
      try {
        await settled;
        noteSubmissionAccepted();
      } catch {
        // The submission failed; the adapter's error path owns the turn.
      }
    })();
  };

  // The two events ShipIt already reads as a turn the CLI began for itself, the
  // ones `beginRearm` answers to. Only a process this prompt did not spawn can
  // be in one: a fresh spawn exists for this prompt alone, and its first output
  // can race the proxied submission. And a signal reaching an executor whose own
  // turn is RUNNING is part of that turn — a finished background task, a late
  // assistant block — not a turn of its own. Merely awaiting a result is not
  // enough: after a turn the CLI started ends, whether this prompt went into it
  // is exactly what is unknown, so a further wake is recorded rather than
  // assumed away.
  const noteCliStartedTurn = (): void => {
    if (input.reuseExistingAgent !== true) return;
    if (ownTurn === "running") return;
    cliTurnPending = true;
  };

  /**
   * The CLI echoing this prompt back is the one positive proof it has read it —
   * stronger than the worker's own answer to the submission, and it can arrive
   * first, so it does not wait for one. Only a turn already ended stays ended.
   */
  const notePromptReadBack = (text: string): void => {
    if (text.trim() !== prompt.trim()) return;
    if (ownTurn === "ended") return;
    cliTurnPending = false;
    ownTurn = "running";
  };

  // A result ends one turn, and a turn the CLI started takes precedence because
  // it began first. Its end says nothing about where this prompt went, so the
  // prompt stays queued rather than becoming the running turn.
  const takeResultAttribution = (): boolean => {
    if (cliTurnPending) {
      cliTurnPending = false;
      return false;
    }
    if (ownTurn !== "queued" && ownTurn !== "running") return false;
    ownTurn = "ended";
    return true;
  };

  const notePromptDelivered = (): void => {
    for (const delivery of input.noticeDeliveries ?? []) {
      try {
        delivery.delivered();
      } catch (err) {
        console.error(`[turn] a prompt-notice receipt for ${sessionId} threw:`, err);
      }
    }
  };

  const settleTurn = (outcome: TurnOutcome): void => {
    if (turnCompleteFired) return;
    turnCompleteFired = true;
    // Clear before notifying the supervisor, but never clear a successor or live retry.
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
    // Hold identity, not the turn epoch (docs/304): the release below must only run when
    // this turn is the owner that actually took the hold off.
    const releasesSystemHold = runner !== null && ownsSystemHold();
    if (releasesSystemHold) runner.systemTurnInProgress = false;
    try {
      // Superseding resets wasInterrupted; the latched superseded flag must take precedence.
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
    } finally {
      // An entry the drain passed over — a system turn behind this one's background work —
      // has no other trigger once the hold comes off (planning#562). Only once this turn's
      // drain has SETTLED: while it is still parked on its commit the release would start a
      // queued turn that can reset the tree (invariant 1), and once it resumes the two would
      // each start a successor. A `none` post-turn belongs to a driver that drains its own
      // queue. Synchronous, so no successor can appear between the decision and the claim;
      // in a `finally`, so a throwing completion callback cannot strand the entry.
      if (releasesSystemHold && drainSettled && postTurn !== "none") releaseQueuedTurn(runner);
      // docs/303 — a system turn holds systemTurnInProgress until here, so a nudge decided
      // during its post-turn sequence could only have queued behind it. Dispatch now that
      // the hold is off; the call is a no-op once the nudge has gone out.
      dispatchStatusNudge();
    }
  };

  if (runner) {
    runner.running = true;
    runner.systemTurnInProgress = input.systemTurn === true;
    runner.activeDeliveryId = input.deliveryId;
    runner.isStreamingActive = useStreaming;
    resetRunnerTurnState(runner);
  }
  // Identifies the hold taken on the line above, not this turn: a CLI-started turn adopted
  // over this one moves the turn epoch without touching the hold, and a driver or a
  // successor can take the hold over while this turn runs (docs/304).
  const heldSystemHoldSeq = runner?.systemHoldSeq;
  const ownsSystemHold = (): boolean =>
    input.systemTurn === true && runner?.systemHoldSeq === heldSystemHoldSeq;

  // Late predecessor exits must not finalize a successor's accumulator or history rows.
  let thisTurnEpoch = runner?.turnEpoch;
  const turnIsCurrent = (): boolean =>
    !runner || thisTurnEpoch === undefined || runner.turnEpoch === thisTurnEpoch;

  const persistGuard = input.persistGuard ?? { done: false };
  const persistUserMessageOnce = (sid: string): boolean => {
    if (persistGuard.done) return false;
    persistGuard.done = true;
    input.persistUserMessage(sid);
    // Echo image URLs need the persisted row; the shared retry latch also prevents duplicate echoes.
    if (input.emitUserEcho) {
      emit({
        type: "system_user_message",
        sessionId: sid,
        text: input.userText,
        activity,
        ...(input.agentInterface ? { agentInterface: input.agentInterface } : {}),
        ...(input.messageOrigin ? { messageOrigin: input.messageOrigin } : {}),
        ...(input.userEcho?.clientRequestId ? { clientRequestId: input.userEcho.clientRequestId } : {}),
        ...(input.userEcho?.images ? { images: input.userEcho.images } : {}),
        ...(input.userEcho?.files ? { files: input.userEcho.files } : {}),
        ...(input.userEcho?.uploadPaths ? { uploadPaths: input.userEcho.uploadPaths } : {}),
        ...(input.userEcho?.userReview ? { userReview: input.userEcho.userReview } : {}),
      });
    }
    return true;
  };

  let automaticRecoveryInProgress = false;
  const recoveryRetryUsed = input.recoveryRetryUsed ?? input.isAuthRetry ?? false;
  const canRecoverAuth = !recoveryRetryUsed && !!deps.ensureAgentTokenFresh;
  // false surfaces sign-in. Do not return false merely because recovery has already started.
  const willRecoverAuth = (): boolean => {
    if (!canRecoverAuth) return false;
    automaticRecoveryInProgress = true;
    return true;
  };
  const finalizeAttemptOutput = (): void => {
    if (!runner) return;
    const messages = buildTurnMessages(
      runner.chatMessageGroups,
      runner.steeredMessages ?? [],
      runner.recordedCards ?? [],
      { inProgress: false },
    );
    if (messages.length === 0) return;
    deps.listenerDeps.chatHistoryManager.replaceInProgress(sessionId, messages);
    deps.listenerDeps.chatHistoryManager.finalizeInProgress(sessionId);
  };
  // Recovery owns teardown after done stands down. Adoption must finish handing over its guards.
  const settleTurnWithoutRedispatch = async (): Promise<void> => {
    if (rearmInFlight) await rearmInFlight;
    settleTurnFacts();
    holdPostTurn();
    try {
      if (runner) runner.running = false;
      await postTurnStep("drain", tryDrain);
      await postTurnStep("commit", runCommitAndPr);
      await postTurnStep("finished", emitFinishedIfIdle);
      await postTurnStep("status-card", settleStatusCard);
      finishTurn();
    } finally {
      releasePostTurn();
    }
  };
  const recoverAuth = async (): Promise<boolean> => {
    let healed: boolean;
    try {
      // Heal this process's account. Force refresh: a revoked token can still have future expiry.
      if (capturedCredentialRoute?.providerRouteKind === "account") {
        healed = deps.ensureAgentTokenFresh
          ? await deps.ensureAgentTokenFresh(
              agentId, capturedCredentialRoute.providerRouteId, { force: true },
            )
          : false;
      } else if (capturedCredentialRoute) {
        healed = false;
        // Reserved secrets are not refresher-managed; the attempted heal is terminal here.
        if (capturedCredentialRoute.providerRouteId) {
          deps.listenerDeps.markCredentialRouteAuthFailed?.(capturedCredentialRoute.providerRouteId);
        }
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
      const policy = capturedRoutePolicy();
      if (
        !recoveryRetryUsed
        && !servingAdoptedTurn
        && capturedCredentialRoute?.providerRouteKind === "account"
        && !!capturedCredentialRoute.providerRouteId
        && policy
        && !policy.stopsOnFailure
        && policy.vendorOwnedRecovery
      ) {
        const routeId = capturedCredentialRoute.providerRouteId;
        automaticRecoveryInProgress = true;
        // A missing credential can make ensureFresh return before it records auth_failed.
        deps.listenerDeps.onAgentAuthRequired?.(agentId);
        finalizeAttemptOutput();
        await retryOnNextAccount(
          {
            routeId,
            label: deps.routeLabel?.(routeId) ?? routeId,
            providerMessage: "Authentication failed; this account must sign in again.",
            resetAt: null,
            failureKind: "auth",
          },
          true,
        );
        return true;
      }
      await settleTurnWithoutRedispatch();
      return false;
    }
    // An adopted turn does not own input.prompt. Heal it, but never rerun its predecessor.
    if (rearmInFlight) await rearmInFlight;
    if (servingAdoptedTurn) {
      console.log(
        `[turn] auth healed for ${sessionId}; adopted turn ends without re-dispatch (docs/140)`,
      );
      // Force the repaired token into the session; ordinary sync can retain a later-expiry dead copy.
      try {
        deps.repushSessionAgentToken?.(sessionId, agentId);
      } catch (err) {
        console.warn("[turn] adopted-turn 401-recovery token repush failed:", err);
      }
      finalizeAttemptOutput();
      await settleTurnWithoutRedispatch();
      return true;
    }
    console.log(`[turn] auth healed for ${sessionId}; re-dispatching turn (quiet auth retry)`);
    try {
      deps.repushSessionAgentToken?.(sessionId, agentId);
    } catch (err) {
      console.warn("[turn] 401-recovery token repush failed:", err);
    }
    finalizeAttemptOutput();
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

  // Env preparation can change both pointers; capture after it and before spawning.
  let activeResumeSessionId: string | null = null;
  let capturedCredentialRoute:
    | Pick<SessionInfo, "providerRouteKind" | "providerRouteId">
    | undefined;
  const recoverMissingConversation = (invalidId: string): boolean => {
    // eslint-disable-next-line no-restricted-syntax -- Claude-only CLI stderr/--resume recovery
    if (agentId !== "claude" || recoveryRetryUsed || invalidId !== activeResumeSessionId) return false;
    const current = deps.listenerDeps.sessionManager.get(sessionId)?.agentSessionId;
    if (current !== invalidId) return false;
    automaticRecoveryInProgress = true;
    clearConversationThread(deps.listenerDeps, sessionId);
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

  let quotaRetryInProgress = false;
  const capturedRoutePolicy = (): CredentialFailurePolicy | undefined => {
    const captured = capturedCredentialRoute;
    if (!captured?.providerRouteKind || !captured.providerRouteId) return undefined;
    const profile = deps.routeProfile?.(captured.providerRouteKind, captured.providerRouteId);
    if (!profile) return undefined;
    return credentialFailurePolicyForRoute(agentId, profile.billingMode, profile.serviceId);
  };
  const quotaRetryAllowed = (): boolean =>
    quotaRefusalCanFailOver(
      capturedRoutePolicy(),
      deps.listenerDeps.sessionManager.get(sessionId),
      servingCliStartedTurn(),
    );

  const retryOnNextAccount = async (
    entry: RefusedAttempt,
    consumeRecoveryBudget = false,
  ): Promise<void> => {
    console.log(
      `[turn] ${agentId} reported a quota refusal for ${sessionId} on ${entry.routeId}; `
      + "retrying on the next eligible credential",
    );
    // Stop the old process before reprovisioning its credential subtree.
    try {
      agent.kill();
    } catch {
      // Already gone.
    }
    const freshAgent = deps.agentFactory(agentId);
    if (runner) {
      runner.setAgent(freshAgent);
      runner.isStreamingActive = false;
      runner.residentRoute = undefined;
    }
    await executeAgentTurn(runner, deps, freshAgent, {
      ...input,
      attemptLedger: [...(input.attemptLedger ?? []), entry],
      ...(consumeRecoveryBudget ? { recoveryRetryUsed: true } : {}),
      reuseExistingAgent: false,
      emitUserEcho: false,
      persistGuard,
    });
  };

  const ledgerEntryFor = (
    providerMessage: string,
    detected: Parameters<typeof exhaustionLockoutUntil>[0],
  ): RefusedAttempt => {
    const routeId = capturedCredentialRoute?.providerRouteId ?? "unknown";
    // Internal fallback lockouts are not provider-reported reset times.
    const statedReset =
      detected.resetAt !== null && !Number.isNaN(Date.parse(detected.resetAt))
        ? new Date(Date.parse(detected.resetAt)).toISOString()
        : null;
    return {
      routeId,
      label: (routeId !== "unknown" ? deps.routeLabel?.(routeId) : undefined) ?? routeId,
      providerMessage: providerMessage.replace(/\s+/g, " ").trim().slice(0, 400),
      resetAt: statedReset,
      failureKind: "quota",
    };
  };

  // At most one automatic continuation per refusal; the wake runs after this turn's teardown.
  let quotaContinuationPending = false;

  // A declined retry still needs an explanation, and quota text must not become a commit subject.
  const retireOnSpentAccount = (opts: {
    summaryIsTheNotice: boolean;
    /** Error path only: the result path's bench is stamped by the listener. */
    benchUntil?: number;
  }): void => {
    if (opts.summaryIsTheNotice) {
      if (runner) runner.turnSummary = "";
      resultTurnSummary = "";
    }
    if (!servingCliStartedTurn()) return;
    if (!quotaRefusalCanFailOver(
      capturedRoutePolicy(),
      deps.listenerDeps.sessionManager.get(sessionId),
    )) return;
    const routeId = capturedCredentialRoute?.providerRouteId;
    // Behind both gates: a metered key is never benched, so the stamp cannot precede them.
    if (opts.benchUntil !== undefined) {
      deps.listenerDeps.markSessionAccountExhausted?.(sessionId, opts.benchUntil, routeId);
    }
    const label = routeId ? (deps.routeLabel?.(routeId) ?? routeId) : "This account";
    // The turn's prompt cannot be replayed, but ShipIt can start a turn of its own, so ask
    // the router before deciding what to tell the user (docs/306-quota-continuation, superseding docs/140).
    quotaContinuationPending = deps.recordQuotaStandDown?.({
      sessionId,
      agentId,
      ...(routeId ? { benchedRouteId: routeId } : {}),
    }).continues === true;
    const outcomeLog = quotaContinuationPending
      ? "the account is benched and ShipIt is continuing the work on another credential"
      : "the account is benched and no credential is free; ShipIt will resume when one is";
    // Req 2: the notice describes the credential, never which kind of turn was interrupted.
    const outcomeNotice = quotaContinuationPending
      ? "is continuing this work on another credential."
      : "will continue this work as soon as one of your credentials is free.";
    console.log(
      `[turn] ${agentId} reported a quota refusal for ${sessionId}`
      + `${routeId ? ` on ${routeId}` : ""} during a CLI-started turn; ${outcomeLog}`,
    );
    emitNoticePostTurn(
      (m) => { if (runner) runner.emitMessage(m); else emit(m); },
      deps.listenerDeps.chatHistoryManager,
      sessionId,
      `${label} is out of quota, so the agent stopped partway through this work. `
      + `ShipIt has set that account aside and ${outcomeNotice}`,
      "warn",
    );
  };

  const runQuotaContinuation = async (): Promise<void> => {
    if (!quotaContinuationPending) return;
    quotaContinuationPending = false;
    // A turn that drained during teardown supersedes this one; the manager holds that rule.
    await deps.continueAfterQuotaStandDown?.(sessionId);
  };

  // A true return takes ownership of teardown; rejected retries must finish it themselves.
  const willRetryOnQuotaError = (err: Error): boolean => {
    if (!turnIsCurrent()) return false;
    if (err instanceof ProviderRouteUnavailableError) return false;
    const exhausted = detectHardExhaustion(err.message);
    if (!exhausted) return false;
    if (!quotaRetryAllowed()) {
      // The same refusal, reported as an adapter error rather than a result. The stand-down
      // self-gates on adoption and on a metered key, and carries the bench because no
      // listener stamps one here. Synchronous by contract: a throw would take the
      // listener's error handling with it.
      try {
        retireOnSpentAccount({
          summaryIsTheNotice: false,
          benchUntil: exhaustionLockoutUntil(exhausted),
        });
      } catch (standDownErr) {
        console.error("[turn] quota stand-down on the error path failed:", standDownErr);
      }
      return false;
    }
    const refusedEntry = ledgerEntryFor(err.message, exhausted);
    try {
      deps.listenerDeps.markSessionAccountExhausted?.(
        sessionId,
        exhaustionLockoutUntil(exhausted),
        capturedCredentialRoute?.providerRouteId,
      );
      // The error listener has not persisted this output yet; save it before retry resets it.
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
      console.error("[turn] quota-retry preparation failed; leaving the turn to the error path:", prepErr);
      return false;
    }
    quotaRetryInProgress = true;
    void retryOnNextAccount(refusedEntry).catch(async (retryErr: unknown) => {
      console.error("[turn] quota retry from the error path failed:", retryErr);
      settleTurnFacts();
      holdPostTurn();
      try {
        if (runner) runner.running = false;
        await postTurnStep("drain", tryDrain);
        await postTurnStep("commit", runCommitAndPr);
        await postTurnStep("finished", emitFinishedIfIdle);
        await postTurnStep("status-card", settleStatusCard);
        finishTurn();
      } finally {
        releasePostTurn();
      }
    });
    return true;
  };

  let receivedResult = false;
  // Distinct from `receivedResult`, which adoption retains from the predecessor so its
  // recovery semantics hold: this says THIS turn produced a result of its own.
  let sawOwnResult = false;

  // ---- docs/303 — status-card settlement (req 11–15) ----
  // Read at each use, never captured: the user can turn the setting off mid-turn, and the
  // nudge must not then start a turn asking for a tool the agent no longer has (req 21).
  const statusCardOn = (): boolean => deps.statusCardEnabled?.() ?? false;
  const statusDeps: SessionStatusDeps = {
    sessionManager: deps.listenerDeps.sessionManager,
    sseBroadcast: deps.listenerDeps.sseBroadcast,
  };
  const storedStatus = () => deps.listenerDeps.sessionManager.get(sessionId)?.sessionStatus;

  let turnFacts: TurnStatusFacts | null = null;
  /**
   * Taken before the drain, because the drained successor resets the runner state these
   * read (docs/303 plan.md → Turn settlement). It CANNOT throw: its call sites are the
   * head of the terminal sequence, before the hold and outside `postTurnStep`, so a throw
   * would abandon the commit behind it (invariant 3), and the status read touches SQLite.
   */
  const settleTurnFacts = (): TurnStatusFacts => {
    if (turnFacts) return turnFacts;
    const cardOn = statusCardOn();
    const facts: TurnStatusFacts = {
      statusUpdated: runner?.statusUpdated ?? false,
      wasInterrupted: runner?.wasInterrupted ?? false,
      // Not `receivedResult`: adoption keeps that from the predecessor on purpose, and a
      // crashed adopted turn produced no result of its own to judge.
      receivedResult: sawOwnResult,
      silent: input.silent === true,
      statusNudge: input.statusNudge === true,
      postTurn,
      writeSeq: 0,
    };
    try {
      // Nothing to read while the feature is off, and nothing will be decided from it.
      if (cardOn) facts.writeSeq = storedStatus()?.writeSeq ?? 0;
    } catch (err) {
      console.error(`[turn] reading the status card for ${sessionId} failed:`, err);
    }
    turnFacts = facts;
    if (cardOn && !facts.silent && !facts.statusUpdated) {
      void markSessionStatusStale(statusDeps, sessionId, facts.writeSeq).catch((err: unknown) => {
        console.error(`[turn] marking the status card stale for ${sessionId} failed:`, err);
      });
    }
    return facts;
  };

  let nudgeDecided = false;
  let nudgePending = false;
  let nudgeDispatched = false;
  // Decided on the snapshot alone, after idle; dispatched separately, because a system
  // turn still holds systemTurnInProgress here and would only queue the nudge behind it.
  const decideStatusNudge = (): void => {
    if (nudgeDecided) return;
    nudgeDecided = true;
    if (!statusCardOn() || !runner) return;
    nudgePending = shouldNudgeForStatusCard(
      settleTurnFacts(),
      storedStatus(),
      runner.running || runner.queueLength > 0,
    );
  };

  const dispatchStatusNudge = (): void => {
    if (!nudgePending || nudgeDispatched || !runner || runner.disposed) return;
    // Re-read rather than trust the decision: a setting turned off since then takes the
    // tool with it, and the turn would ask for something the agent cannot call.
    if (!statusCardOn()) return;
    // Re-checked here, not only at the decision: the deferral is about the session's
    // state when the nudge would start, and that turn is checked afresh when it ends.
    if (runner.running || runner.systemTurnInProgress || runner.mergeHold) return;
    if (runner.queueLength > 0) {
      nudgePending = false;
      return;
    }
    // A system turn would replace the resident process and destroy its background work.
    // One attempt per missing update (req 15), so a blocked nudge is simply not made: the
    // card stays stale and the next ordinary turn is checked afresh.
    if (!runner.canRunDispatchedTurn || systemTurnBlockedByResidentWork(runner, true)) return;
    nudgeDispatched = true;
    // The nudge is this turn's post-turn work until the turn it starts takes over — and
    // "takes over" is not when `dispatch` returns. It sets `running` synchronously, but the
    // turn epoch only advances when the successor enters its executor, so a predecessor
    // exiting during the async setup in between still reads as current and clears the
    // reservation. The lease spans that window; `PostTurnHold` expires on its own, so a
    // turn that outlives the deadline is covered by `running` and the epoch by then.
    runner.beginPostTurnWork();
    let leaseHeld = true;
    const releaseLease = (): void => {
      if (!leaseHeld) return;
      leaseHeld = false;
      runner.endPostTurnWork();
    };
    try {
      // Through `dispatch`, not an enqueue plus a drain: only that path owns recovery when
      // turn setup rejects, and without it a message queued during setup is stranded with
      // nothing left to start it.
      const handle = runner.dispatch(prepareDispatch({
        text: statusNudgePrompt(storedStatus()),
        agentInterface: undefined,
        messageOrigin: undefined,
        execution: "dispatched",
        activity: "Updating the status card…",
        images: undefined,
        files: undefined,
        uploads: undefined,
        permissionMode: input.permissionMode,
        postTurn: undefined,
        systemTurn: true,
        onTurnComplete: undefined,
        deliveryId: undefined,
        dictated: undefined,
        resetMergedBranch: undefined,
        compactContext: undefined,
        silent: undefined,
        statusNudge: true,
      }));
      void (async () => {
        try {
          await handle.settled;
        } finally {
          releaseLease();
        }
      })();
    } catch (err) {
      console.error(`[turn] dispatching the status-card nudge for ${sessionId} failed:`, err);
      releaseLease();
    }
  };

  const settleStatusCard = (): void => {
    decideStatusNudge();
    dispatchStatusNudge();
  };

  deps.listenerDeps.sseBroadcast("session_agent_started", { sessionId, activity });

  wireAgentListeners(agent, runner, deps.listenerDeps, {
    isNewSession: input.isNewSession,
    persistUserMessage: persistUserMessageOnce,
    fallbackTitle: input.fallbackTitle,
    capturedSessionId: sessionId,
    getCapturedRouteId: () => capturedCredentialRoute?.providerRouteId,
    getCapturedRouteKind: () => capturedCredentialRoute?.providerRouteKind,
    getCapturedRoutePolicy: capturedRoutePolicy,
    isServingAdoptedTurn: () => servingCliStartedTurn(),
    ...(canRecoverAuth ? { willRecoverAuth, recoverAuth } : {}),
    willRetryOnQuotaError,
    // eslint-disable-next-line no-restricted-syntax -- Claude-only CLI stderr/--resume recovery
    ...(!recoveryRetryUsed && agentId === "claude" ? { recoverMissingConversation } : {}),
    ...(input.permissionMode !== undefined ? { requestedPermissionMode: input.permissionMode } : {}),
    // An adapter error can be terminal without a later done event, even with an empty queue.
    onError: async () => {
      agentErrored = true;
      if (rearmInFlight) await rearmInFlight;
      settleTurnFacts();
      holdPostTurn();
      try {
        finishTurn();
        await postTurnStep("drain", tryDrain);
        await postTurnStep("commit", runCommitAndPr);
        // A quota refusal can reach the executor as an adapter error; continue from here too.
        await postTurnStep("quota-continuation", runQuotaContinuation);
        await postTurnStep("status-card", settleStatusCard);
      } finally {
        releasePostTurn();
      }
    },
    ...(input.useStreaming !== undefined ? { useStreaming: input.useStreaming } : {}),
    ...(adoptsCliStartedTurns ? { adoptsCliStartedTurns: true } : {}),
  });

  if (!input.isNewSession) {
    if (persistUserMessageOnce(sessionId)) {
      input.afterUserMessagePersisted?.(sessionId);
    }
  }

  // Every terminal step must continue after failure, particularly the steps before commit.
  const postTurnStep = async (label: string, run: () => void | Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (err) {
      console.error(`[turn] post-turn step "${label}" failed for ${sessionId} (continuing):`, err);
    }
  };

  // running becomes false before teardown ends; hold the runner against idle reclamation.
  let postTurnHeld = false;
  const holdPostTurn = (): void => {
    if (postTurnHeld || !runner) return;
    postTurnHeld = true;
    runner.beginPostTurnWork();
  };
  const releasePostTurn = (): void => {
    if (!postTurnHeld || !runner) return;
    postTurnHeld = false;
    runner.endPostTurnWork();
  };

  let sawAuthRequired = false;
  agent.on("auth_required", () => { sawAuthRequired = true; });

  const stderrTail = createAgentStderrTail();
  agent.on("log", (source: string, text: string) => { stderrTail.record(source, text); });

  // The successor owns teardown. Release this turn's hold and arm any already-made commit.
  agent.on("superseded", () => {
    if (automaticRecoveryInProgress || quotaRetryInProgress) return;
    wasSuperseded = true;
    finishTurn();
    releasePostTurn();
    armPendingPush();
  });

  let turnStartHeadHash: string | null = input.turnStartHeadHash;

  let tokenSyncFired = false;
  const trySyncToken = (): void => {
    if (tokenSyncFired) return;
    tokenSyncFired = true;
    deps.finalizeAgentEnv?.(sessionId, agentId, capturedCredentialRoute);
  };

  let resultTurnSummary: string | null = null;
  let servingAdoptedTurn = false;
  // Adoption already counts while its async handover still awaits the predecessor's teardown.
  const servingCliStartedTurn = (): boolean => servingAdoptedTurn || rearmInFlight !== null;

  let drainFired = false;
  // Fired vs. settled: the flag is set before the commit this awaits, so only `drainSettled`
  // says the local commit has happened and no drain of this turn's is still to come.
  let drainSettled = false;
  const tryDrain = async (): Promise<void> => {
    if (drainFired) return;
    drainFired = true;
    try {
      if (!turnIsCurrent()) return;
      if (runner) runner.running = false;
      if (postTurn === "none") return;
      // Commit locally before a queued turn can reset the tree. Network flows stay after drain.
      if ((runner?.queueLength ?? 0) > 0) await commitOnce();
      // A CLI-started turn can take ownership during the commit await.
      if (!turnIsCurrent()) return;
      await input.drainNext({ ownsSystemHold: ownsSystemHold() });
    } finally {
      drainSettled = true;
    }
  };

  const runCommit = async (): Promise<string | null> => {
    if (postTurn === "none") return null;
    if (!runner?.sessionDir) return null;
    // Live text includes late Codex completion; after adoption, use this turn's saved summary.
    const summarySource = turnIsCurrent() ? runner.turnSummary : (resultTurnSummary ?? runner.turnSummary);
    const summary = summarySource.split("\n")[0]?.slice(0, 120) || activity || "Agent turn";
    try {
      if (deps.commitTurn) {
        return await deps.commitTurn({
          sessionDir: runner.sessionDir,
          sessionId,
          summary,
          turnStartHeadHash,
          runner,
          emit,
          deferPushArm: (arm) => { pendingPushArm = arm; },
        });
      }
      // Minimal setups bypass postTurnCommit, so they need the same auto-commit gate here.
      if (!sessionAutoCommitAllowed(deps.listenerDeps.sessionManager, sessionId)) return null;
      const result = await deps.autoCommit(runner.sessionDir, summary);
      if (result.unreadable) {
        emitNoticePostTurn(
          emit,
          deps.listenerDeps.chatHistoryManager,
          sessionId,
          formatUnreadableWorkspaceNotice(result.unreadable, { committed: result.commitHash !== null }),
          "warn",
        );
      }
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
      deps.scheduleAutoPush(runner.sessionDir, sessionId);
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

  // Memoize promises, not results, so concurrent terminal paths join the same work.
  let commitPromise: Promise<string | null> | null = null;
  const commitOnce = (): Promise<string | null> => (commitPromise ??= runCommit());

  const runCommitAndPrInner = async (): Promise<void> => {
    if (postTurn === "none") return;
    try {
      await runPostTurnFlows();
    } finally {
      armPendingPush();
    }
  };

  const runPostTurnFlows = async (): Promise<void> => {
    const commitHash = await commitOnce();
    if (commitHash && runner) {
      try {
        await deps.postTurnPrFlow?.(sessionId, runner.sessionDir, commitHash, emit);
      } catch (err) {
        console.error("[turn] pr-lifecycle flow failed:", err);
      }
    }
    // A reset to base can clear a merged card without creating a commit.
    if (runner && deps.postTurnReArmReset) {
      try {
        await deps.postTurnReArmReset(sessionId, runner.sessionDir, emit);
      } catch (err) {
        console.error("[turn] pr re-arm (reset) flow failed:", err);
      }
    }
    if (runner && deps.postTurnReleaseFlow) {
      try {
        await deps.postTurnReleaseFlow(sessionId, runner.sessionDir, runner.accumulatedText, emit);
      } catch (err) {
        console.error("[turn] release flow failed:", err);
      }
    }
  };

  let commitAndPrPromise: Promise<void> | null = null;
  const runCommitAndPr = (): Promise<void> => (commitAndPrPromise ??= runCommitAndPrInner());

  // Update viewers before slow PR work; a drained successor suppresses finished/started flicker.
  const broadcastFinishedIfIdle = (): void => {
    if (runner?.running) return;
    deps.listenerDeps.sseBroadcast("session_agent_finished", { sessionId });
  };

  // Idle triggers remediation, so it must follow commit/PR work.
  const signalIdleIfIdle = (): void => {
    if (runner?.running) return;
    runner?.onAgentFinished();
  };

  const emitFinishedIfIdle = (): void => {
    broadcastFinishedIfIdle();
    signalIdleIfIdle();
  };

  let streamingPostTurnFired = false;
  let streamingPostTurn: Promise<void> | null = null;

  // Keep receivedResult/turnCompleteFired: adoption must not retry or settle the original prompt.
  const rearmForCliStartedTurn = async (reason: string): Promise<void> => {
    // Sample before awaiting teardown; the adopted CLI can move HEAD while the PR flow runs.
    const headAtAdoption: { value: string | null } = { value: null };
    await postTurnStep("read-head-at-adoption", async () => {
      headAtAdoption.value = (await input.readTurnStartHeadHash?.()) ?? null;
    });
    await postTurnStep("await-post-turn", () => streamingPostTurn ?? Promise.resolve());
    if (!streamingPostTurnFired) return;
    console.log(`[turn] ${reason} for ${sessionId}; re-arming the post-turn flow`);
    servingAdoptedTurn = true;
    tokenSyncFired = false;
    drainFired = false;
    streamingPostTurnFired = false;
    streamingPostTurn = null;
    turnStartHeadHash = headAtAdoption.value;
    commitPromise = null;
    commitAndPrPromise = null;
    resultTurnSummary = null;
    // The adopted turn is a turn of its own: it settles its own facts and is decided afresh.
    turnFacts = null;
    sawOwnResult = false;
    nudgeDecided = false;
    nudgePending = false;
    nudgeDispatched = false;
    thisTurnEpoch = runner?.turnEpoch;
  };

  // An adopted turn can finish before handover; every terminal path must wait for this promise.
  let rearmInFlight: Promise<void> | null = null;
  const beginRearm = (reason: string): Promise<void> => {
    if (!useStreaming) return Promise.resolve();
    if (rearmInFlight) return rearmInFlight;
    if (!streamingPostTurnFired) return Promise.resolve();
    const pending = rearmForCliStartedTurn(reason).finally(() => {
      if (rearmInFlight === pending) rearmInFlight = null;
    });
    rearmInFlight = pending;
    return pending;
  };

  agent.on("event", async (event: AgentEvent) => {
    if (event.type === "agent_self_wake") {
      noteCliStartedTurn();
      await beginRearm("self-wake");
      return;
    }
    if (event.type === "agent_user_replay") {
      notePromptReadBack(event.text);
      return;
    }
    if (event.type === "agent_assistant") {
      if (!adoptsCliStartedTurns) return;
      if (!event.parentToolUseId) {
        noteCliStartedTurn();
        await beginRearm("cli-started turn");
      }
      return;
    }
    if (event.type !== "agent_result") return;
    // Capture before an await lets adoption reset the live summary.
    if (runner && resultTurnSummary === null) resultTurnSummary = runner.turnSummary;
    if (rearmInFlight) await rearmInFlight;
    receivedResult = true;
    sawOwnResult = true;
    // Taken before any early return below: a result ends one turn either way.
    const answersThisPrompt = takeResultAttribution();
    runner?.emit("turn_result", { compact: input.compact === true });
    // Claude can report quota exhaustion as successful final text, without event.error.
    const exhausted = event.error
      ? detectHardExhaustion(event.error)
      : detectHardExhaustionInTurnText(runner?.turnSummary);
    if (exhausted) {
      if (quotaRetryAllowed()) {
        quotaRetryInProgress = true;
        await retryOnNextAccount(
          ledgerEntryFor(event.error ?? runner?.turnSummary ?? "quota exhausted", exhausted),
        );
        return;
      }
      await postTurnStep("quota-stand-down", () => {
        retireOnSpentAccount({ summaryIsTheNotice: !event.error });
      });
    }
    // Anything riding this prompt is delivered here, and must not be delivered
    // in `settleTurn`: a resident streaming turn settles no turn at all, and its
    // listeners are discarded by the next reuse. Every condition holds the
    // notice back rather than proves delivery, which is the safe direction
    // (docs/299-agent-settings-access plan.md → And a notice on the next turn).
    //
    // `answersThisPrompt` is the whole of the "is this result mine" question,
    // and it is asked of the turns this executor watched begin rather than of
    // flags describing what is happening now. Both orderings of the woken-turn
    // defect defeated the latter, in opposite directions: a wake AFTER a failed
    // dispatched turn, and a wake already in flight when the prompt was
    // submitted, which no "am I serving an adopted turn" flag can see because by
    // then the prompt has been submitted and nothing is being adopted.
    // requirements.md records a woken turn as carrying no notice and waiting for
    // the next dispatched one; attributing its result elsewhere is what would
    // make that untrue.
    //
    // `wasSuperseded` stays a condition of its own, because a retired process
    // emits a result for a prompt that IS its own after a successor took the
    // agent slot, and this turn is then settled `interrupted` with its work
    // discarded. Acknowledging there spends the receipt on a turn whose output
    // nobody reads, and the successor — which carries the same notice — has none
    // left to settle. The failover and quota-retry paths do NOT set the flag,
    // deliberately: those re-dispatch the same prompt on a new executor, which
    // records its own submission and acknowledges that.
    if (
      answersThisPrompt && !exhausted && !wasSuperseded
      && resultIsTheAgentsOwn(event)
    ) {
      notePromptDelivered();
    }
    // Retry decisions still need adoption state; finalization after a result does not.
    servingAdoptedTurn = false;
    settleTurnFacts();
    if (useStreaming) {
      if (streamingPostTurnFired) return;
      streamingPostTurnFired = true;
      holdPostTurn();
      streamingPostTurn = (async () => {
        try {
          await postTurnStep("token-sync", trySyncToken);
          await postTurnStep("drain", tryDrain);
          await postTurnStep("finished-sse", broadcastFinishedIfIdle);
          await postTurnStep("commit", runCommitAndPr);
          await postTurnStep("idle", signalIdleIfIdle);
          // Last of all: the continuation is a new turn, so this one must be fully settled.
          await postTurnStep("quota-continuation", runQuotaContinuation);
          await postTurnStep("status-card", settleStatusCard);
        } finally {
          releasePostTurn();
        }
      })();
      await streamingPostTurn;
    } else {
      // One-shot teardown spans result and done; done releases this hold.
      holdPostTurn();
      await postTurnStep("token-sync", trySyncToken);
      await postTurnStep("drain", tryDrain);
    }
  });

  agent.on("done", async (code: number | null) => {
    console.log("[turn] agent exited with code", code);
    deps.listenerDeps.broadcastLog("server", `Agent process exited with code ${code}`);
    // Recovery owns teardown and any hold it opened; do not release it here.
    if (automaticRecoveryInProgress) return;
    if (quotaRetryInProgress) return;
    // After the handover, never before it: a turn adopted here owns this terminal path,
    // and the predecessor's snapshot would be discarded by the re-arm anyway.
    if (rearmInFlight) await rearmInFlight;
    settleTurnFacts();
    holdPostTurn();
    try {
      if (runner) {
        if (runner.getAgent() === agent) {
          runner.setAgent(null);
          if (useStreaming) runner.isStreamingActive = false;
          runner.clearBackgroundTasks();
        }
      }

      // A completed predecessor still owes its memoized flow; an unfinished stale turn stands down.
      if (!receivedResult && !turnIsCurrent()) {
        console.warn(
          `[turn] stale exit (code ${code}) for ${sessionId} ignored — a newer turn owns the session`,
        );
        return;
      }

      if (!useStreaming) await postTurnStep("token-sync", trySyncToken);

      if (
        input.emitErrorOnNoResult
        && !receivedResult
        && !sawAuthRequired
        && !(runner?.wasInterrupted ?? false)
      ) {
        const base = code !== 0
          ? `Agent process exited with code ${code}`
          : "Agent process ended without a response";
        const detail = stderrTail.describe();
        const message = detail ? `${base}: ${detail}` : base;
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
      // Finalize partial rows before the next turn's replaceInProgress can delete them.
      if (!receivedResult && !sawAuthRequired) {
        await postTurnStep("finalize-partial-turn", () => input.onInterruptedTurn?.());
      }

      if (
        input.onNoResultExit &&
        !receivedResult &&
        !sawAuthRequired &&
        !(runner?.wasInterrupted ?? false)
      ) {
        let handled = false;
        await postTurnStep("no-result-exit-hook", async () => {
          handled = await input.onNoResultExit!(code, stderrTail.describe());
        });
        if (handled) return;
      }

      // Adoption retains receivedResult from its predecessor, but its partial rows still need saving.
      if (
        (!receivedResult || servingAdoptedTurn)
        && !sawAuthRequired
        && !agentErrored
        && !input.onInterruptedTurn
        && !wasSuperseded
        && runner !== null
        && runner.getAgent() === null
      ) {
        await postTurnStep("finalize-partial-turn-fallback", () => {
          const partial = buildTurnMessages(
            runner.chatMessageGroups,
            runner.steeredMessages ?? [],
            runner.recordedCards ?? [],
            { inProgress: false },
          );
          deps.listenerDeps.chatHistoryManager.replaceInProgress(sessionId, partial);
          deps.listenerDeps.chatHistoryManager.finalizeInProgress(sessionId);
          runner.clearTurnEventBuffer();
        });
      }

      if (useStreaming) {
        // Crash paths need a commit even with no queued turn and no agent_result. Only
        // while this turn still owns the runner, though: a successor started during this
        // turn's post-turn sequence — a drained entry, or the docs/303 status nudge — has
        // already claimed `running`, and clearing it here reports that live turn as idle
        // and lets the enforcer reclaim its runner (invariant 5). `tryDrain` below has
        // carried the same guard all along.
        if (runner && turnIsCurrent()) runner.running = false;
        await postTurnStep("drain", tryDrain);
        await postTurnStep("finished-sse", broadcastFinishedIfIdle);
        await postTurnStep("commit", runCommitAndPr);
        await postTurnStep("idle", signalIdleIfIdle);
        // Only fires when the result's own sequence did not reach it (a second result).
        await postTurnStep("quota-continuation", runQuotaContinuation);
        await postTurnStep("status-card", settleStatusCard);
        finishTurn();
        return;
      }

      // A late task notification can leave a one-shot process marked running after exit.
      const unlatched = runner?.getAgent() === null && runner.running;
      if (unlatched) runner.running = false;

      await postTurnStep("drain", tryDrain);
      await postTurnStep("finished-sse", broadcastFinishedIfIdle);
      await postTurnStep("commit", runCommitAndPr);
      await postTurnStep("idle", signalIdleIfIdle);
      // The result event may have spent tryDrain before the phantom turn accumulated a queue.
      if (unlatched && (runner?.queueLength ?? 0) > 0) {
        await postTurnStep(
          "drain-after-unlatch",
          () => input.drainNext({ ownsSystemHold: ownsSystemHold() }),
        );
      }
      await postTurnStep("status-card", settleStatusCard);
      finishTurn();
      // A message that arrived after the result queued behind this turn's hold, which
      // finishTurn only just released; tryDrain was spent and idle declines on a
      // non-empty queue, so nothing else would ever start it (docs/304). The drain
      // belongs to the owning driver under postTurn "none", exactly as in tryDrain.
      if (runner && postTurn !== "none" && runner.queueLength > 0) {
        await postTurnStep("release-queued", () => { releaseQueuedTurn(runner); });
      }
    } finally {
      settleTurn(turnNoResult(`agent process exited (code ${code}) without settling the turn`));
      releasePostTurn();
    }
  });

  // Restart adoption attaches listeners to a surviving process; do not send another prompt.
  if (input.adopt) {
    const resident = runner?.residentRoute;
    capturedCredentialRoute = resident
      ? { providerRouteKind: resident.kind, providerRouteId: resident.id }
      : undefined;
    return;
  }

  try {
    // Prepare before reading run parameters: credential repair can change the resume ID.
    const envBegan = Date.now();
    const prep = await deps.prepareAgentEnv?.(sessionId, agentId, {
      reusingResidentAgent: input.reuseExistingAgent === true,
      ...(input.attemptLedger?.length
        ? { excludeRouteIds: input.attemptLedger.map((entry) => entry.routeId) }
        : {}),
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
    const lastRefusal = input.attemptLedger?.at(-1);
    if (runner && turnRoute) {
      const routeLabel = deps.routeLabel?.(turnRoute.id) ?? turnRoute.id;
      if (lastRefusal) {
        const reason = lastRefusal.failureKind === "auth"
          ? "could not authenticate"
          : "is out of quota";
        emitNoticeInTurn(
          runner,
          sessionId,
          `${lastRefusal.label} ${reason} — continuing this turn on ${routeLabel}.`,
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
      // undefined also matters: it restores the CLI's default permission mode.
      if (runner && runner.appliedPermissionMode !== input.permissionMode && agent.setPermissionMode) {
        agent.setPermissionMode(input.permissionMode);
        runner.appliedPermissionMode = input.permissionMode;
      }
      agent.sendUserMessage(prompt);
      noteSubmitted();
    } else {
      if (input.deliveryId !== undefined) agent.setDeliveryId?.(input.deliveryId);
      // docs/303 req 15 — the worker reports it back, so a restart mid-nudge adopts a turn
      // that still knows it is one and is not nudged again.
      if (input.statusNudge === true) agent.setStatusNudge?.(true);
      const paramsBegan = Date.now();
      const runParams = await deps.buildRunParams(
        sessionId,
        agentId,
        prompt,
        turnRoute,
        input.compact ? { compact: true } : undefined,
      );
      console.log(`[turn] build-run-params for ${sessionId} took ${Date.now() - paramsBegan}ms; spawning agent`);
      agent.run(input.useStreaming !== undefined ? { ...runParams, useStreaming: input.useStreaming } : runParams);
      noteSubmitted();
      if (runner) runner.appliedPermissionMode = input.permissionMode;
      if (runner) {
        runner.appliedSpawnIdentity = desiredSpawnIdentity(
          deps.listenerDeps.sessionManager,
          sessionId,
          agentId,
        );
        runner.residentRoute = turnRoute ? { kind: turnRoute.kind, id: turnRoute.id } : undefined;
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (error instanceof ProviderRouteUnavailableError && input.attemptLedger?.length) {
      error.message = allRefusedMessage(input.attemptLedger);
    }
    agent.emit("error", error);
  }
}
