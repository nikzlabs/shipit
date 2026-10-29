import type { WsServerMessage, ClaudeContentBlockText, ClaudeContentBlockToolUse, TurnUsage, PermissionMode, LogSource } from "../../shared/types.js";
import { atApiRatesFor, resolveTurnCost, selectionOf, turnAttributionFor, type PricedUsage } from "../turn-attribution.js";
import type { AgentEvent, AgentProcess } from "../../shared/types.js";
import type { AgentId, SubscriptionLimitsMap } from "../../shared/types.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import { resetRunnerTurnState } from "../session-runner.js";
import { noteTurnReady, noteTurnSubmitted, setSteerRefused, stoppedByUser, turnInSetup } from "../turn-stop-request.js";
import { queueEntryId, requeueInSendOrder } from "../queue-identity.js";
import { returnQueueSentBeforeStop } from "../queue-return.js";
import type { ChatHistoryManager, PersistedPermissionRequest } from "../chat-history.js";
import { retireRewindUndo } from "../chat-history.js";
import type { CredentialFailurePolicy } from "../credential-failure-policy.js";
import { quotaRefusalCanFailOver } from "../credential-failure-policy.js";
import { toListRow, type SessionManager } from "../sessions.js";
import type { UsageManager } from "../usage.js";
import {
  getContextWindowForModel,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
} from "../../shared/agent-registry.js";
import type { VoiceNotePayload, VoiceNoteSource } from "../../shared/types/voice-note-types.js";
import { emitChatCard, emitNoticeInTurn, finalizeTurnRows, persistTurnInProgress } from "../chat-card-persistence.js";
import { denyAbandonedPermissionCards, settlePermissionCard } from "../permission-cards.js";
import { buildUnansweredPermissionNotice, watchPermissionWait } from "../permission-wait-notice.js";
import type { CompactionCard } from "../../shared/types.js";
import crypto from "node:crypto";
import {
  extractToolResults,
  stampToolDurations,
  stampToolUseStartTimes,
  cliPermissionModeToApplied,
  isWellFormedAskUserQuestion,
  createAgentToolTracker,
} from "./agent-event-normalizer.js";
import { projectAgentEventForWire } from "../transcript-projection.js";
import {
  accumulateAssistantGroups,
  attachSubagentAssistant,
  attachSubagentToolResults,
  attachToolResultsToGroup,
  requeueUndeliveredSteers,
  stampLastGroup,
  steerToQueuedMessage,
} from "./agent-message-builder.js";
import { derivePermissionHeadline, observeVoiceNotes } from "./agent-voice-handler.js";
import { retireFinishedBackgroundSubagent } from "./subagent-retire.js";
import { wireAuthRequiredHandler } from "./agent-auth-handler.js";
import {
  detectHardExhaustion,
  detectHardExhaustionInTurnText,
  exhaustionLockoutUntil,
  normalizeAgentUsageLimitError,
} from "./agent-rate-limits.js";
import { ProviderRouteUnavailableError } from "../provider-route-preflight.js";
import { recordAgentGoal } from "../services/agent-goal.js";

export { buildTurnMessages, persistTurnInProgress } from "../chat-card-persistence.js";

export { extractToolResults, stampToolDurations, stampToolUseStartTimes } from "./agent-event-normalizer.js";
export { recordSteeredMessage, requeueUndeliveredSteers } from "./agent-message-builder.js";
export { normalizeAgentUsageLimitError } from "./agent-rate-limits.js";

export interface AgentListenerDeps {
  sessionManager: SessionManager;
  chatHistoryManager: ChatHistoryManager;
  usageManager: UsageManager;
  sseBroadcast: (event: string, data: unknown) => void;
  broadcastLog: (source: LogSource, text: string) => void;
  getSelectedModel: () => string | undefined;
  recordAgentRateLimits?: (
    agentId: AgentId,
    session: { usedPct: number | null; resetAt: string } | null,
    weekly: { usedPct: number | null; resetAt: string } | null,
    sessionId?: string,
    /** Captured route; the session can change before terminal telemetry arrives. */
    routeId?: string,
  ) => void;
  getSubscriptionLimitsSnapshot?: () => SubscriptionLimitsMap;
  /** until is epoch milliseconds. */
  markSessionAccountExhausted?: (sessionId: string, until: number, routeId?: string) => void;
  markCredentialRouteAuthFailed?: (routeId: string) => void;
  clearCredentialRouteAuthFailed?: (routeId: string) => void;
  nudgeClaudeOAuthRefresh?: () => void;
  onAgentAuthRequired?: (agentId: AgentId) => void;
  deliverVoiceNote?: (
    payload: VoiceNotePayload,
    runner: SessionRunnerInterface,
    source: VoiceNoteSource,
  ) => void;
}

export const CONTEXT_WINDOW_TOKENS = DEFAULT_CONTEXT_WINDOW_TOKENS;

// Whitespace-tolerant because the trimmed chunks it is matched across lose a split space.
const MISSING_CONVERSATION = /No\s*conversation\s*found\s*with\s*session\s*ID/i;
// docs/007 — the rewind point is not in the stored conversation, or a CLI bump dropped the flag.
const MISSING_REWIND_POINT = /No\s*message\s*found\s*with\s*message\.uuid|unknown\s*option\s*'--resume-session-at'/i;
const MISSING_CONVERSATION_WINDOW = 200;

const CANNOT_RESUME_MESSAGE = "The agent could not resume this session's conversation. ShipIt kept it and did not "
  + "start a new one. To continue in a new conversation, fork the session.";
const CANNOT_REWIND_MESSAGE = "The agent could not rewind this session's conversation to the point you chose. "
  + "ShipIt kept the conversation and did not start a new one. To continue from that point, fork the session there.";

export interface WireListenersOpts {
  isNewSession: boolean;
  persistUserMessage: (sessionId: string) => void;
  fallbackTitle?: string;
  /** Required at runtime despite the optional type. */
  capturedSessionId?: string;
  /** Read after environment preparation; wiring precedes failover. */
  getCapturedRouteId?: () => string | undefined;
  getCapturedRouteKind?: () => "account" | "reserved" | "string" | undefined;
  getCapturedRoutePolicy?: () => CredentialFailurePolicy | undefined;
  isServingAdoptedTurn?: () => boolean;
  requestedPermissionMode?: PermissionMode;
  onError?: () => Promise<void>;
  /** Claims recovery synchronously, before killing the process can trigger teardown. */
  willRecoverAuth?: () => boolean;
  /** true means handled, including adopted turns healed without redispatch. */
  recoverAuth?: () => Promise<boolean>;
  /** The CLI could not resume the stored conversation and is exiting; the card is posted. */
  onConversationNotFound?: () => void;
  /** docs/007 req 5 — this turn's conversation id was stored: the session keeps that conversation. */
  onConversationKept?: () => void;
  /** true transfers terminal cleanup to the retry. */
  willRetryOnQuotaError?: (err: Error) => boolean;
  useStreaming?: boolean;
  /** Distinct from streaming: Codex can emit final text after its result without starting a turn. */
  adoptsCliStartedTurns?: boolean;
  /** docs/333-idle-compaction — a compaction turn's usage row starts no idle-compaction deadline. */
  compactionTurn?: boolean;
  /** docs/333-idle-compaction — a silent compaction is maintenance, not use of the session. */
  maintenanceTurn?: boolean;
  /**
   * docs/333-idle-compaction — a turn adopted after a restart: its events are replayed, so when
   * they arrive says nothing about when its requests ran, and its row carries no anchor.
   */
  anchorUnknown?: boolean;
}

/**
 * docs/322-question-holds-automatic-turns req 7 — the agent is waiting for the user, so a
 * turn its CLI starts on its own is stopped at once. What woke it stays in its context for
 * the user's reply, and the turn ends as the question did: still waiting.
 */
export function stopOwnTurnWhileAwaitingAnswer(
  runner: SessionRunnerInterface,
  agent: Pick<AgentProcess, "interrupt">,
  broadcastLog: AgentListenerDeps["broadcastLog"],
): void {
  if (!runner.answerHold) return;
  runner.awaitingUserAnswer = true;
  runner.wasInterrupted = true;
  agent.interrupt();
  broadcastLog("server", "Agent interrupted: its own turn started while it waits for the user's answer");
}

export function wireAgentListeners(
  agent: AgentProcess,
  runner: SessionRunnerInterface | null,
  deps: AgentListenerDeps,
  opts: WireListenersOpts,
): void {
  if (!opts.capturedSessionId) {
    throw new Error("wireAgentListeners requires opts.capturedSessionId");
  }
  const ownerSessionId = opts.capturedSessionId;
  const sessionAtTurnStart = deps.sessionManager.get(opts.capturedSessionId);
  let turnModel: string | undefined = sessionAtTurnStart?.model ?? deps.getSelectedModel();
  const turnAttributionAtStart = turnAttributionFor(selectionOf(sessionAtTurnStart));
  // Local adapter errors bypass SSE stale-event filtering; compare the turn epoch too.
  let wiredTurnEpoch = runner?.turnEpoch;
  const emitToViewers = (msg: WsServerMessage) => {
    if (runner) {
      runner.emitMessage(msg);
    } else {
      console.warn(`[agent-listeners] dropping ${msg.type} — no runner attached`);
    }
  };

  let hasLoggedAgentStart = false;

  // Init precedes resume validation, and a fork's replay is retired with the write: an id
  // is stored once its conversation answered (output or a successful result). See the
  // result handler for the one unanswered case.
  let pendingAgentSessionId: string | null = null;
  let agentSessionIdPersisted = false;
  let missingConversationDetected = false;
  let conversationAnswered = false;
  let sawTurnResult = false;
  // Pipe chunks can split the CLI's line.
  let recentStderr = "";

  // docs/333-idle-compaction — when the turn's last model request started: the turn's start,
  // or its last tool result, which the next request follows at once. Where it errs, it errs
  // early, which compacts sooner and never after the cache is cold.
  let cacheAnchorAt = Date.now();
  let anchorKnown = opts.anchorUnknown !== true;
  let compactionTurn = opts.compactionTurn === true;
  let maintenanceTurn = opts.maintenanceTurn === true;

  const adoptCliStartedTurn = (reason: string): void => {
    if (!runner) return;
    // Task notifications also arrive mid-turn; resetting then would erase its history. A claim
    // still in setup is no turn yet: the claiming turn waits for this one (planning#703). Only on
    // a resident process — no next turn takes a one-shot one.
    const startsTurn = !runner.running
      || (opts.useStreaming === true && sawTurnResult && turnInSetup(runner));
    if (startsTurn) {
      resetRunnerTurnState(runner);
      wiredTurnEpoch = runner.turnEpoch;
      // The CLI's own turn is ordinary work, also on a process a compaction ran on.
      cacheAnchorAt = Date.now();
      anchorKnown = true;
      compactionTurn = false;
      maintenanceTurn = false;
    }
    runner.running = true;
    // The CLI is already generating, so a Stop must reach its process.
    noteTurnSubmitted(runner);
    // Only for the turn that this adoption began. A wake during another turn's setup must
    // not say that the agent has that turn's prompt.
    if (startsTurn) noteTurnReady(runner);
    const turnSessionId = opts.capturedSessionId;
    // A turn the CLI starts on its own is new use (docs/316 req 5).
    if (turnSessionId && startsTurn) deps.sessionManager.track(turnSessionId);
    if (turnSessionId && startsTurn) retireRewindUndo(deps.chatHistoryManager, turnSessionId);
    if (turnSessionId) {
      emitToViewers({
        type: "session_status",
        sessionId: turnSessionId,
        running: true,
        queueLength: runner.queueLength,
      });
      if (startsTurn && opts.useStreaming === true) {
        deps.sseBroadcast("session_agent_started", { sessionId: turnSessionId });
      }
    }
    console.log(`[cli-turn] runner=${runner.sessionId} adopted a turn the orchestrator did not start (${reason})`);
    if (startsTurn) stopOwnTurnWhileAwaitingAnswer(runner, agent, deps.broadcastLog);
  };

  const persistAgentSessionIdIfReady = (): void => {
    if (agentSessionIdPersisted) return;
    if (missingConversationDetected) return;
    if (!pendingAgentSessionId) return;
    const turnSessionId = opts.capturedSessionId;
    if (!turnSessionId) return;
    deps.sessionManager.setAgentSessionId(turnSessionId, pendingAgentSessionId);
    agentSessionIdPersisted = true;
    opts.onConversationKept?.();
  };

  // Synthetic CLI answers can race the interrupt and disable unanswered cards.
  const suppressedToolResultIds = new Set<string>();
  let sawAuthRequiredThisTurn = false;
  agent.on("auth_required", () => { sawAuthRequiredThisTurn = true; });

  // A process death can emit both error and agent_result.
  let persistedTerminalErrorRow = false;

  let sawHardExhaustionThisTurn = false;

  const toolTracker = createAgentToolTracker(opts.capturedSessionId, emitToViewers);

  agent.on("log", (source: string, text: string) => {
    deps.broadcastLog(source as "stderr" | "stdout" | "server", text);
    if (source === "stderr") recentStderr = (recentStderr + text).slice(-MISSING_CONVERSATION_WINDOW);
    // The stored id is kept and nothing is retried: only a fork starts a new conversation.
    const message = source === "stderr" && !missingConversationDetected
      ? MISSING_CONVERSATION.test(recentStderr)
        ? CANNOT_RESUME_MESSAGE
        : MISSING_REWIND_POINT.test(recentStderr) ? CANNOT_REWIND_MESSAGE : null
      : null;
    if (message) {
      missingConversationDetected = true;
      pendingAgentSessionId = null;
      const turnSessionId = opts.capturedSessionId;
      if (runner && turnSessionId) {
        emitChatCard(
          runner,
          { type: "error", message, sessionId: turnSessionId },
          { role: "assistant", text: `Error: ${message}`, isError: true },
          { chatHistoryManager: deps.chatHistoryManager, sessionId: turnSessionId },
        );
      } else {
        emitToViewers({ type: "error", message });
      }
      opts.onConversationNotFound?.();
    }
  });

  agent.on("event", (rawEvent: AgentEvent) => {
    let event = rawEvent;
    if (event.type === "agent_rate_limits") {
      deps.recordAgentRateLimits?.(
        agent.agentId,
        event.session,
        event.weekly,
        opts.capturedSessionId,
        opts.getCapturedRouteId?.(),
      );
      return;
    }

    if (event.type === "agent_goal_updated") {
      if (opts.capturedSessionId) recordAgentGoal(deps, opts.capturedSessionId, event.goal);
      return;
    }

    if (event.type === "agent_steer_rejected") {
      const turnSessionId = opts.capturedSessionId;
      if (runner) {
        const pending = runner.steeredMessages;
        const rejectedText = event.text.trim();
        const droppedIdx = pending.findIndex((s) => !s.delivered && s.assembledPrompt?.trim() === rejectedText);
        // No match: an errored turn already re-queued it, so enqueueing again would run it twice.
        if (droppedIdx >= 0) {
          const dropped = pending[droppedIdx];
          runner.steeredMessages = pending.filter((_, i) => i !== droppedIdx);
          if (turnSessionId) {
            persistTurnInProgress(deps.chatHistoryManager, runner, turnSessionId);
          }
          if (!dropped.bestEffort) {
            const requeued = steerToQueuedMessage(dropped);
            // A message of the user's is back in the queue, and the delivery must not send it
            // again by itself. A refused notice from another source says nothing about theirs.
            if (requeued.execution === "interactive" && requeued.automatic !== true) {
              setSteerRefused(runner, true);
            }
            const position = requeueInSendOrder(runner, requeued);
            emitToViewers({
              type: "message_queued",
              sessionId: runner.sessionId,
              id: queueEntryId(requeued),
              text: dropped.text,
              position,
            });
            deps.broadcastLog(
              "server",
              `Live steer rejected by ${agent.agentId} — re-queued for the next turn.`,
            );
            // The rejection can come after the stopped turn's last drain (docs/330).
            returnQueueSentBeforeStop(runner);
          }
        }
        // A worker with no agent at all would otherwise hold the turn, and the re-queued
        // message, until a viewer's reconciler noticed.
        void runner.verifyRunningState();
      }
      return;
    }

    if (event.type === "agent_user_replay") {
      if (runner) {
        const steers = runner.steeredMessages;
        const echoed = event.text.trim();
        const idx = steers.findIndex(
          (s) => !s.delivered && s.assembledPrompt?.trim() === echoed,
        );
        if (idx >= 0) {
          const next = steers.slice();
          // Not stamped: a steer is stored as a queued command under another id (docs/007).
          next[idx] = { ...next[idx], delivered: true };
          runner.steeredMessages = next;
        }
      }
      return;
    }

    if (event.type === "agent_compaction_started") {
      const turnSessionId = opts.capturedSessionId;
      if (turnSessionId) {
        emitToViewers({
          type: "compaction_status",
          sessionId: turnSessionId,
          active: true,
          ...(event.trigger ? { trigger: event.trigger } : {}),
        });
      }
      return;
    }

    if (event.type === "agent_background_tasks") {
      const turnSessionId = opts.capturedSessionId;
      if (runner) {
        runner.setBackgroundTasks(event.tasks);
        if (turnSessionId) {
          // Do not send session_status: task-list changes are not turn boundaries.
          emitToViewers({
            type: "background_tasks",
            sessionId: turnSessionId,
            count: runner.backgroundTaskCount,
            descriptions: runner.backgroundTaskDescriptions,
          });
        }
      }
      return;
    }

    if (event.type === "agent_self_wake") {
      const turnSessionId = opts.capturedSessionId;
      // One-shot CLIs can notify between result and exit; the executor's done clears running.
      adoptCliStartedTurn("self-wake");
      if (turnSessionId && event.toolUseId) {
        retireFinishedBackgroundSubagent(deps.chatHistoryManager, runner, emitToViewers, {
          sessionId: turnSessionId,
          toolUseId: event.toolUseId,
          status: event.status,
          summary: event.summary,
          usage: event.usage,
        });
      }
      return;
    }

    if (event.type === "agent_compacted") {
      const turnSessionId = opts.capturedSessionId;
      if (turnSessionId && runner) {
        emitToViewers({ type: "compaction_status", sessionId: turnSessionId, active: false });
        const card: CompactionCard = {
          id: `compaction-${crypto.randomUUID()}`,
          createdAt: new Date().toISOString(),
          ...(event.trigger ? { trigger: event.trigger } : {}),
          ...(event.preTokens !== undefined ? { preTokens: event.preTokens } : {}),
          ...(event.postTokens !== undefined ? { postTokens: event.postTokens } : {}),
          ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
        };
        emitChatCard(
          runner,
          { type: "compaction_card", sessionId: turnSessionId, card },
          { role: "assistant", text: "", compaction: card },
          { chatHistoryManager: deps.chatHistoryManager, sessionId: turnSessionId },
        );
      }
      return;
    }

    if (event.type === "agent_permission_request") {
      const turnSessionId = opts.capturedSessionId;
      if (turnSessionId && runner) {
        const createdAt = new Date().toISOString();
        const card: PersistedPermissionRequest = {
          requestId: event.requestId,
          phase: "pending",
          toolName: event.toolName,
          ...(event.path ? { path: event.path } : {}),
          ...(event.summary ? { summary: event.summary } : {}),
          ...(event.details ? { details: event.details } : {}),
          ...(event.agentId ? { agentId: event.agentId } : {}),
          createdAt,
        };
        emitChatCard(
          runner,
          {
            type: "permission_request_card",
            sessionId: turnSessionId,
            requestId: event.requestId,
            toolName: event.toolName,
            ...(event.path ? { path: event.path } : {}),
            ...(event.summary ? { summary: event.summary } : {}),
            ...(event.details ? { details: event.details } : {}),
            ...(event.agentId ? { agentId: event.agentId } : {}),
            createdAt,
          },
          { role: "assistant", text: "", permissionPrompt: card },
          { chatHistoryManager: deps.chatHistoryManager, sessionId: turnSessionId },
        );

        const startsWait = runner.awaitingPermissionIds.size === 0;
        runner.awaitingPermissionIds.add(event.requestId);
        deps.sseBroadcast("session_attention", {
          sessionId: turnSessionId,
          awaitingPermission: true,
        });
        // One alert per wait, as the sidebar's: subagents can open several cards at once.
        if (startsWait) {
          deps.deliverVoiceNote?.({ summary: derivePermissionHeadline(event.toolName) }, runner, "permission");
        }
        // The main agent is blocked inside any other gated call, and reads no line until it returns.
        if (event.subagent === "background") {
          watchPermissionWait(runner, {
            requestId: event.requestId,
            summary: event.summary ?? event.toolName,
          });
        }
      }
      return;
    }

    if (event.type === "agent_permission_resolved") {
      const turnSessionId = opts.capturedSessionId;
      if (turnSessionId && runner) {
        // A Stop also ends the call, and the user who pressed it knows why.
        const unanswered = event.callEnded && !stoppedByUser(runner) ? event.callEnded : undefined;
        settlePermissionCard(
          runner,
          turnSessionId,
          deps,
          event.requestId,
          event.behavior === "allow" ? "approved" : "denied",
          event.remembered,
          unanswered && { ...(unanswered.waitedMs !== undefined ? { waitedMs: unanswered.waitedMs } : {}) },
        );
        if (unanswered) {
          deps.sessionManager.appendPendingAgentNotice(
            turnSessionId,
            buildUnansweredPermissionNotice(unanswered.summary),
          );
        }
      }
      return;
    }

    if (event.type === "agent_result") {
      const normalizedError = event.error
        ? normalizeAgentUsageLimitError(
            agent.agentId,
            event.error,
            deps.getSubscriptionLimitsSnapshot?.(),
          )
        : undefined;
      // Claude can report quota exhaustion as assistant text on a successful result.
      const noticeText = normalizedError ? null : (runner?.turnSummary ?? null);
      const detected = normalizedError
        ? detectHardExhaustion(normalizedError)
        : detectHardExhaustionInTurnText(noticeText);
      // Suppress the error row only when failover owns the outcome, including adopted-turn rules.
      sawHardExhaustionThisTurn =
        detected !== null
        && quotaRefusalCanFailOver(
          opts.getCapturedRoutePolicy?.(),
          opts.capturedSessionId ? deps.sessionManager.get(opts.capturedSessionId) : undefined,
          opts.isServingAdoptedTurn?.() ?? false,
        );
      const exhaustedSessionId = opts.capturedSessionId;
      if (exhaustedSessionId && deps.markSessionAccountExhausted && detected) {
        deps.markSessionAccountExhausted(
          exhaustedSessionId,
          exhaustionLockoutUntil(detected),
          opts.getCapturedRouteId?.(),
        );
      }
      // A redirected service can emit auth_required and then a result; preserve that failure.
      const authenticatedRouteId = opts.getCapturedRouteId?.();
      if (authenticatedRouteId && !sawAuthRequiredThisTurn) {
        deps.clearCredentialRouteAuthFailed?.(authenticatedRouteId);
      }
      if (normalizedError !== undefined) {
        event = { ...event, error: normalizedError };
      } else if (detected && noticeText) {
        event = { ...event, status: "error", error: noticeText.trim() };
      }
    }

    // Wire content can be a string despite the declared array type.
    const toolResultContent = (event as { content?: unknown }).content;
    if (
      event.type === "agent_tool_result" &&
      suppressedToolResultIds.size > 0 &&
      Array.isArray(toolResultContent)
    ) {
      const content: unknown[] = toolResultContent;
      const filtered = content.filter((b) => {
        if (typeof b !== "object" || b === null) return true;
        const id = (b as Record<string, unknown>).tool_use_id;
        return typeof id !== "string" || !suppressedToolResultIds.has(id);
      });
      if (filtered.length === 0) return;
      if (filtered.length !== content.length) {
        event = { ...event, content: filtered };
      }
    }

    if (event.type === "agent_tool_result") {
      event = stampToolDurations(event, toolTracker.toolUseStartTimes, Date.now());
    }

    // Stamp before the wire emit and before accumulation, so the live row and
    // the persisted row carry the same time.
    if (event.type === "agent_assistant") {
      event = stampToolUseStartTimes(event, toolTracker.toolUseStartTimes, Date.now());
    }

    const isInternalStreamCompletion =
      event.type === "agent_assistant" && event.isStreamCompletion;
    if (!isInternalStreamCompletion) {
      // Keep full bodies for persistence; only results persist synchronously in this tick.
      const wireEvent = projectAgentEventForWire(ownerSessionId, event, (id) => toolTracker.getToolName(id));
      emitToViewers({ type: "agent_event", sessionId: ownerSessionId, event: wireEvent });
    }

    if (event.type === "agent_init") {
      const turnSessionId = opts.capturedSessionId!;
      // Compaction and subagents can emit further init events without a new process.
      const isFirstInit = !hasLoggedAgentStart;
      if (!hasLoggedAgentStart) {
        hasLoggedAgentStart = true;
        deps.broadcastLog("server", "Agent process started");
      }
      pendingAgentSessionId ??= event.sessionId;
      const session = deps.sessionManager.get(turnSessionId);
      if (session) {
        const row = toListRow(session);
        emitToViewers({ type: "session_started", session: row });
        deps.sseBroadcast("session_started", { session: row });
      }
      if (opts.isNewSession) {
        console.log(`[persist-user] agent_init session=${turnSessionId} (isNewSession branch)`);
        opts.persistUserMessage(turnSessionId);
      }

      if (event.model) {
        turnModel = event.model;
        emitToViewers({
          type: "model_info",
          sessionId: turnSessionId,
          model: event.model,
          contextWindowTokens: getContextWindowForModel(event.model),
        });
      }

      if (opts.requestedPermissionMode === "guarded" && runner && isFirstInit) {
        if (event.permissionMode === "auto") {
          runner.guardedUnavailable = false;
        } else {
          runner.guardedUnavailable = true;
          emitNoticeInTurn(
            runner,
            turnSessionId,
            "Guarded mode isn't available for this account or model, so this turn is running in auto mode (no command safety check). It needs a Max, Team, or Enterprise plan, and it does not run on Haiku before 5.5.",
            deps.chatHistoryManager,
            "warn",
          );
        }
      }

      // Re-init can report a changed mode; synchronize it even after the first init.
      if (runner) {
        const synced = cliPermissionModeToApplied(event.permissionMode);
        if (synced !== "unrecognized") {
          runner.appliedPermissionMode = synced;
        }
      }
    }

    if (event.type === "agent_assistant") {
      // Adopt before accumulation resets history. Init alone can be a mode-change response.
      if (
        opts.adoptsCliStartedTurns && sawTurnResult && runner
        && (!runner.running || turnInSetup(runner)) && !event.parentToolUseId
      ) {
        adoptCliStartedTurn("post-result assistant output");
      }

      if (!event.synthetic) {
        conversationAnswered = true;
        persistAgentSessionIdIfReady();
      }

      const text = (event.content ?? [])
        .filter((b): b is ClaudeContentBlockText => b.type === "text")
        .map((b) => b.text)
        .join("\n\n");

      const toolBlocks = (event.content ?? [])
        .filter((b): b is ClaudeContentBlockToolUse => b.type === "tool_use");

      // Deltas already populated chat groups; use the full text only for the summary.
      if (event.isStreamCompletion) {
        if (text && runner) runner.turnSummary = text;
        return;
      }

      if (toolBlocks.length > 0) toolTracker.recordToolUses(toolBlocks);

      if (event.parentToolUseId && runner) {
        attachSubagentAssistant(runner, event.parentToolUseId, text, toolBlocks);
        return;
      }

      if (text && runner) {
        runner.turnSummary = text;
        runner.accumulatedText += text;
      }

      if (toolBlocks.length > 0 && runner) {
        runner.accumulatedToolUse = [...runner.accumulatedToolUse, ...toolBlocks];
      }

      if (runner && toolBlocks.some((t) => t.name === "EnterPlanMode")) {
        runner.appliedPermissionMode = "plan";
      }

      if ((text || toolBlocks.length > 0) && runner) {
        accumulateAssistantGroups(runner, text, toolBlocks);
        // Text the CLI wrote itself may sit in a conversation that is never stored.
        if (!event.synthetic && event.messageId) stampLastGroup(runner, event.messageId);
      }

      if (runner) {
        observeVoiceNotes(runner, toolBlocks, deps.deliverVoiceNote);
      }

      // docs/303 req 13 — what ends the turn by asking the user, whether or not the
      // interrupt below applies: non-streaming `ExitPlanMode` ends the turn on its own,
      // and `wasInterrupted` also latches on a user stop, which is not this (req 38).
      if (runner && toolBlocks.some(
        (t) => isWellFormedAskUserQuestion(t) || t.name === "ExitPlanMode",
      )) {
        runner.awaitingUserAnswer = true;
      }

      // Both CLI modes auto-answer. Interrupt only valid questions that the user can answer.
      if (runner && toolBlocks.some(isWellFormedAskUserQuestion)) {
        runner.wasInterrupted = true;
        for (const t of toolBlocks) {
          if (isWellFormedAskUserQuestion(t)) suppressedToolResultIds.add(t.id);
        }
        agent.interrupt();
        deps.broadcastLog("server", "Agent interrupted: waiting for AskUserQuestion answer");
      }

      // Streaming ExitPlanMode also auto-resolves; keep the approval card interactive.
      if (opts.useStreaming && runner && toolBlocks.some((t) => t.name === "ExitPlanMode")) {
        runner.wasInterrupted = true;
        for (const t of toolBlocks) {
          if (t.name === "ExitPlanMode") suppressedToolResultIds.add(t.id);
        }
        agent.interrupt();
        deps.broadcastLog("server", "Agent interrupted: waiting for plan approval");
      }
    }

    if (event.type === "agent_tool_result") {
      cacheAnchorAt = Date.now();
      const toolResults = extractToolResults(event);

      if (toolResults.length > 0) toolTracker.reportMcpCrashesFromResults(toolResults);

      if (event.parentToolUseId && runner && toolResults.length > 0) {
        attachSubagentToolResults(runner, event.parentToolUseId, toolResults);
        return;
      }

      if (runner) runner.needsNewMessageGroup = true;

      if (toolResults.length > 0 && runner) {
        attachToolResultsToGroup(runner, toolResults);
        if (event.messageId) stampLastGroup(runner, event.messageId);
      }

      const usageSessionId = opts.capturedSessionId;
      if (usageSessionId && runner) {
        persistTurnInProgress(deps.chatHistoryManager, runner, usageSessionId);
        runner.lastPersistedBufferIndex = runner.getTurnEventBuffer().length;
      } else if (usageSessionId) {
        deps.chatHistoryManager.replaceInProgress(usageSessionId, []);
      }
    }

    if (event.type === "agent_result") {
      const turnSessionId = opts.capturedSessionId;
      if (turnSessionId) {
        // An unanswered failure (a refusal, a Stop) may only name a session's first
        // conversation: never replace a stored id, nor retire a fork's replay unread.
        const firstConversation = !sessionAtTurnStart?.agentSessionId
          && !sessionAtTurnStart?.conversationReplay;
        const storable = event.status === "success" || conversationAnswered || firstConversation;
        if (!missingConversationDetected && storable) {
          deps.sessionManager.setAgentSessionId(turnSessionId, event.sessionId);
          agentSessionIdPersisted = true;
          opts.onConversationKept?.();
        }
        // A PR that merged during this turn resolves the session (docs/316 req 5).
        if (!maintenanceTurn) {
          deps.sessionManager.touchUnlessResolved(turnSessionId);
          deps.sseBroadcast("session_list", { sessions: deps.sessionManager.list() });
        }
      }

      // Non-guarded turns can report permission denials too; do not call them classifier blocks.
      if (
        event.permissionDenials?.length
        && turnSessionId
        && runner
        && opts.requestedPermissionMode === "guarded"
      ) {
        const blockedTools = [...new Set(event.permissionDenials.map((d) => d.toolName))].join(", ");
        const count = event.permissionDenials.length;
        emitNoticeInTurn(
          runner,
          turnSessionId,
          `Guarded mode blocked ${count} action${count === 1 ? "" : "s"} (${blockedTools}) as potentially unsafe. ` +
            "Rephrase with a narrower scope, run the command yourself, or switch to auto mode for this action.",
          deps.chatHistoryManager,
          "warn",
        );
      }

      const usageSessionId = turnSessionId ?? event.sessionId;

      if (event.contextWindow && turnModel && turnSessionId) {
        emitToViewers({
          type: "model_info",
          sessionId: turnSessionId,
          model: turnModel,
          contextWindowTokens: event.contextWindow,
        });
      }

      let perTurnUsage: TurnUsage | undefined;
      const hasUsageTelemetry =
        event.cost?.totalUsd !== undefined
        || event.tokens?.input !== undefined
        || event.tokens?.output !== undefined;
      if (hasUsageTelemetry) {
        perTurnUsage = {
          inputTokens: event.tokens?.input ?? 0,
          outputTokens: event.tokens?.output ?? 0,
          costUsd: event.cost?.totalUsd ?? 0,
          durationMs: event.durationMs,
          timestamp: new Date().toISOString(),
        };
        if (event.tokens?.cacheRead !== undefined) perTurnUsage.cacheRead = event.tokens.cacheRead;
        if (event.tokens?.cacheWrite !== undefined) perTurnUsage.cacheCreate = event.tokens.cacheWrite;
        if (turnModel) perTurnUsage.model = turnModel;
        if (event.contextTokens !== undefined) perTurnUsage.contextTokens = event.contextTokens;
      }

      if (perTurnUsage) {
        const turnAttribution =
          turnAttributionAtStart
          ?? turnAttributionFor(selectionOf(deps.sessionManager.get(usageSessionId)));
        const pricedUsage: PricedUsage = {
          tokens: {
            input: event.tokens?.input,
            output: event.tokens?.output,
            cacheRead: event.tokens?.cacheRead,
            cacheWrite: event.tokens?.cacheWrite,
          },
          requests: event.requests,
          contextTokens: event.contextTokens,
        };
        const resolvedCost = resolveTurnCost({
          harnessId: agent.agentId,
          attribution: turnAttribution,
          reportedCostUsd: event.cost?.totalUsd,
          usage: pricedUsage,
        });
        // docs/333-idle-compaction — a turn whose requests read nothing did not touch the
        // cache, so the previous turn's anchor still describes it.
        const touchedCache =
          (event.tokens?.input ?? 0) + (event.tokens?.cacheRead ?? 0) + (event.tokens?.cacheWrite ?? 0) > 0;
        perTurnUsage.costUsd = deps.usageManager.record(
          usageSessionId,
          resolvedCost.costUsd,
          event.durationMs ?? 0,
          event.tokens?.input,
          event.tokens?.output,
          {
            cacheRead: event.tokens?.cacheRead,
            cacheCreate: event.tokens?.cacheWrite,
            model: turnModel,
            contextTokens: event.contextTokens,
            ...(event.requests ? { requests: event.requests } : {}),
            costSource: resolvedCost.costSource,
            // Preserve cumulative continuity across billing-mode changes.
            ...(event.cost?.totalUsd !== undefined
              ? { cumulativeSnapshot: event.cost.totalUsd }
              : {}),
            ...(turnAttribution ? { attribution: turnAttribution } : {}),
            ...(opts.getCapturedRouteId?.()
              ? { credentialRouteId: opts.getCapturedRouteId()! }
              : {}),
            cacheScope: { agentId: agent.agentId, model: sessionAtTurnStart?.model ?? null },
            ...(event.cacheTtl ? { cacheTtl: event.cacheTtl } : {}),
            ...(!compactionTurn && anchorKnown && touchedCache ? { cacheAnchorAt } : {}),
          },
        );
        if (turnAttribution) {
          perTurnUsage.billingMode = turnAttribution.billingMode;
        }
        // The same function and inputs as the stored row, so reload shows this figure.
        const atApiRates = atApiRatesFor(turnAttribution, pricedUsage);
        if (atApiRates !== undefined) perTurnUsage.atApiRatesUsd = atApiRates;
        const sessionUsage = deps.usageManager.getSessionUsage(usageSessionId);
        if (sessionUsage) {
          const tokenTotals = deps.usageManager.getSessionTokenTotals(usageSessionId);
          emitToViewers({
            type: "usage_update",
            sessionId: sessionUsage.sessionId,
            totals: sessionUsage.totals,
            groups: sessionUsage.groups ?? [],
            totalDurationMs: sessionUsage.totalDurationMs,
            turnCount: sessionUsage.turnCount,
            cumulativeInputTokens: tokenTotals?.cumulativeInputTokens,
            cumulativeOutputTokens: tokenTotals?.cumulativeOutputTokens,
          });
          if (perTurnUsage) {
            emitToViewers({
              type: "turn_usage_update",
              sessionId: sessionUsage.sessionId,
              turn: perTurnUsage,
              totals: sessionUsage.totals,
              turnCount: sessionUsage.turnCount,
            });
          }
        }
      } else if (opts.getCapturedRouteId?.()) {
        // Record the route even without usage, for the next turn's route-change comparison.
        deps.usageManager.record(usageSessionId, 0, event.durationMs ?? 0, undefined, undefined, {
          ...(turnModel ? { model: turnModel } : {}),
          credentialRouteId: opts.getCapturedRouteId()!,
        });
      }

      // Remove undelivered steers before finalization; queued turns will persist them.
      if (runner) requeueUndeliveredSteers(runner, emitToViewers);

      const resultError = (event as { error?: string }).error;
      const turnHasVisibleContent =
        (runner?.chatMessageGroups ?? []).some((g) => g.text || g.toolUse.length > 0);
      if (
        resultError
        && !turnHasVisibleContent
        && !(runner?.wasInterrupted ?? false)
        && !sawAuthRequiredThisTurn
        && !missingConversationDetected
        && !persistedTerminalErrorRow
        && !sawHardExhaustionThisTurn
      ) {
        persistedTerminalErrorRow = true;
        try {
          if (runner) {
            emitChatCard(
              runner,
              { type: "error", message: resultError, sessionId: usageSessionId },
              { role: "assistant", text: `Error: ${resultError}`, isError: true },
              { chatHistoryManager: deps.chatHistoryManager, sessionId: usageSessionId },
            );
          } else {
            emitToViewers({ type: "error", message: resultError });
            deps.chatHistoryManager.append(usageSessionId, {
              role: "assistant",
              text: `Error: ${resultError}`,
              isError: true,
            });
          }
        } catch (err) {
          console.error(
            `[agent] failed to persist the terminal error row for ${usageSessionId}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      finalizeTurnRows(deps.chatHistoryManager, runner, usageSessionId);
      if (runner) runner.lastPersistedBufferIndex = runner.getTurnEventBuffer().length;

      if (runner?.pendingCommitLink) {
        const { commitHash, parentCommitHash } = runner.pendingCommitLink;
        const updatedId = deps.chatHistoryManager.updateLastMessage(usageSessionId, {
          commitHash,
          parentCommitHash,
        });
        if (updatedId !== null) {
          runner.pendingCommitLink = null;
          const messageIndex = deps.chatHistoryManager.indexOfMessageId(usageSessionId, updatedId);
          if (messageIndex >= 0) {
            emitToViewers({
              type: "commit_linked",
              messageIndex,
              commitHash,
              parentCommitHash,
            });
          }
        }
      }

      // A maintenance turn leaves the last real turn's outcome in place (docs/333-idle-compaction).
      const turnErrored = Boolean((event as { error?: unknown }).error) && !runner?.wasInterrupted;
      if (runner && !maintenanceTurn) runner.lastTurnErrored = turnErrored;
      if (turnSessionId && !maintenanceTurn) deps.sessionManager.setLastTurnErrored(turnSessionId, turnErrored);

      sawTurnResult = true;

      if (runner) {
        runner.running = false;
        runner.clearTurnEventBuffer();
      }
      if (turnSessionId) {
        emitToViewers({
          type: "session_status",
          sessionId: turnSessionId,
          running: false,
          queueLength: runner?.queueLength ?? 0,
        });
      }
    }
  });

  wireAuthRequiredHandler(agent, runner, deps, opts, emitToViewers);

  agent.on("error", async (err: Error) => {
    // Check before retry: a stale error must not change the successor's route or state.
    if (
      runner !== null &&
      wiredTurnEpoch !== undefined &&
      runner.turnEpoch !== wiredTurnEpoch
    ) {
      console.warn(
        `[agent] stale process error ignored for ${opts.capturedSessionId} — a newer turn owns the session (${err.message})`,
      );
      return;
    }
    if (opts.willRetryOnQuotaError?.(err) === true) return;
    const blocked = err instanceof ProviderRouteUnavailableError;
    const display = blocked ? err.message : `Agent process error: ${err.message}`;
    console.error(blocked ? "[agent] turn blocked:" : "[agent] process error:", err.message);
    deps.broadcastLog("server", display);
    emitToViewers({ type: "error", message: display });
    const turnSessionId = opts.capturedSessionId;
    // A steer the CLI never acked was reported to its sender as delivered; the drain runs it.
    if (runner) requeueUndeliveredSteers(runner, emitToViewers);
    // Only while this process holds the slot, so a replacement's requests are left alone.
    // A throw must not skip onError below, which commits (post-turn invariant 3).
    if (runner && turnSessionId && runner.getAgent() === agent) {
      try {
        denyAbandonedPermissionCards(runner, turnSessionId, deps);
      } catch (err) {
        console.error(`[agent] denying abandoned permission cards for ${turnSessionId} failed:`, err);
      }
    }
    if (turnSessionId) {
      finalizeTurnRows(deps.chatHistoryManager, runner, turnSessionId);
      if (!persistedTerminalErrorRow) {
        persistedTerminalErrorRow = true;
        deps.chatHistoryManager.append(turnSessionId, {
          role: "assistant",
          text: blocked ? err.message : `Error: ${err.message}`,
          isError: true,
        });
      }
    }
    if (runner) {
      if (runner.getAgent() === agent) {
        runner.setAgent(null);
        runner.isStreamingActive = false;
        runner.clearBackgroundTasks();
      }
      runner.running = false;
      if (!maintenanceTurn) {
        runner.lastTurnErrored = true;
        if (turnSessionId) deps.sessionManager.setLastTurnErrored(turnSessionId, true);
      }
      runner.clearTurnEventBuffer();
      if (turnSessionId) {
        emitToViewers({
          type: "session_status",
          sessionId: turnSessionId,
          running: false,
          queueLength: runner.queueLength,
          error: `Agent process error: ${err.message}`,
        });
      }
    }
    if (turnSessionId) {
      deps.sseBroadcast("session_agent_finished", { sessionId: turnSessionId });
    }

    if (opts.onError) {
      try {
        await opts.onError();
      } catch (drainErr) {
        console.error("[agent] error-path drain failed:", drainErr);
      }
    }
    // Idle can trigger disposal or remediation; signal it after drain and commit.
    runner?.onAgentFinished();
  });
}
