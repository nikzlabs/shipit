import type { WsServerMessage, ClaudeContentBlockText, ClaudeContentBlockToolUse, TurnUsage, PermissionMode, LogSource } from "../../shared/types.js";
import { costFromRates, resolveTurnCost, selectionOf, turnAttributionFor } from "../turn-attribution.js";
import type { AgentEvent, AgentProcess } from "../../shared/types.js";
import type { AgentId, SubscriptionLimitsMap } from "../../shared/types.js";
import type { SessionRunnerInterface, QueuedMessage } from "../session-runner.js";
import { resetRunnerTurnState } from "../session-runner.js";
import type { ChatHistoryManager, PersistedPermissionRequest } from "../chat-history.js";
import type { CredentialFailurePolicy } from "../credential-failure-policy.js";
import { quotaRefusalCanFailOver } from "../credential-failure-policy.js";
import type { SessionManager } from "../sessions.js";
import type { UsageManager } from "../usage.js";
import {
  getContextWindowForModel,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
} from "../../shared/agent-registry.js";
import type { VoiceNotePayload, VoiceNoteSource } from "../../shared/types/voice-note-types.js";
import { emitChatCard, emitNoticeInTurn, buildTurnMessages, persistTurnInProgress, updateRecordedCard } from "../chat-card-persistence.js";
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
import { projectAgentEventForWire, markMessagesCommitted } from "../transcript-projection.js";
import {
  accumulateAssistantGroups,
  attachSubagentAssistant,
  attachSubagentToolResults,
  attachToolResultsToGroup,
  requeueUndeliveredSteers,
} from "./agent-message-builder.js";
import { observeVoiceNotes } from "./agent-voice-handler.js";
import { retireFinishedBackgroundSubagent } from "./subagent-retire.js";
import { wireAuthRequiredHandler } from "./agent-auth-handler.js";
import {
  detectHardExhaustion,
  detectHardExhaustionInTurnText,
  exhaustionLockoutUntil,
  normalizeAgentUsageLimitError,
} from "./agent-rate-limits.js";
import { ProviderRouteUnavailableError } from "../provider-route-preflight.js";

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
  recoverMissingConversation?: (agentSessionId: string) => boolean;
  /** true transfers terminal cleanup to the retry. */
  willRetryOnQuotaError?: (err: Error) => boolean;
  useStreaming?: boolean;
  /** Distinct from streaming: Codex can emit final text after its result without starting a turn. */
  adoptsCliStartedTurns?: boolean;
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

  // Init precedes resume validation; wait for output before replacing the stored ID.
  let pendingAgentSessionId: string | null = null;
  let agentSessionIdPersisted = false;
  let missingConversationDetected = false;
  let sawTurnResult = false;

  const adoptCliStartedTurn = (reason: string): void => {
    if (!runner) return;
    // Task notifications also arrive mid-turn; resetting then would erase its history.
    const startsTurn = !runner.running;
    if (startsTurn) {
      resetRunnerTurnState(runner);
      wiredTurnEpoch = runner.turnEpoch;
    }
    runner.running = true;
    const turnSessionId = opts.capturedSessionId;
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
  };

  const persistAgentSessionIdIfReady = (): void => {
    if (agentSessionIdPersisted) return;
    if (missingConversationDetected) return;
    if (!pendingAgentSessionId) return;
    const turnSessionId = opts.capturedSessionId;
    if (!turnSessionId) return;
    deps.sessionManager.setAgentSessionId(turnSessionId, pendingAgentSessionId);
    agentSessionIdPersisted = true;
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
    const missingConversation = source === "stderr"
      ? /No conversation found with session ID:\s*([^\s]+)/i.exec(text)
      : null;
    if (missingConversation) {
      if (!missingConversationDetected) {
        missingConversationDetected = true;
        pendingAgentSessionId = null;
        const invalidId = missingConversation[1];
        const recovering = opts.recoverMissingConversation?.(invalidId) ?? false;
        if (!recovering) {
          const message = "Couldn't resume the previous conversation. ShipIt could not start a fresh thread automatically; resend your message or open Settings → Agents if the problem continues.";
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
        }
      }
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

    if (event.type === "agent_steer_rejected") {
      const turnSessionId = opts.capturedSessionId;
      if (runner) {
        const pending = runner.steeredMessages;
        const dropped = pending[0];
        if (dropped) {
          runner.steeredMessages = pending.slice(1);
          if (turnSessionId) {
            persistTurnInProgress(deps.chatHistoryManager, runner, turnSessionId);
          }
        }
        const requeueText = dropped?.text ?? event.text;
        const queued: QueuedMessage = { text: requeueText, execution: "interactive" };
        if (dropped?.images && dropped.images.length > 0) queued.images = dropped.images;
        if (dropped?.files && dropped.files.length > 0) {
          queued.files = dropped.files.map((f) => ({ path: f.path }));
        }
        const position = runner.enqueue(queued);
        emitToViewers({ type: "message_queued", text: requeueText, position });
        deps.broadcastLog(
          "server",
          `Live steer rejected by ${agent.agentId} (turn not steerable) — re-queued for the next turn.`,
        );
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

        runner.awaitingPermissionIds.add(event.requestId);
        deps.sseBroadcast("session_attention", {
          sessionId: turnSessionId,
          awaitingPermission: true,
        });
      }
      return;
    }

    if (event.type === "agent_permission_resolved") {
      const turnSessionId = opts.capturedSessionId;
      if (turnSessionId && runner) {
        const phase = event.behavior === "allow" ? "approved" : "denied";
        // Patch recorded cards before rebuilding history, or the pending phase returns.
        const requestId = event.requestId;
        const remembered = event.remembered;
        const patchedRecorded = updateRecordedCard(
          runner,
          (m) => m.permissionPrompt?.requestId === requestId,
          (m) => ({
            ...m,
            permissionPrompt: {
              ...m.permissionPrompt!,
              phase,
              ...(remembered ? { remembered: true } : {}),
            },
          }),
        );
        if (patchedRecorded) {
          persistTurnInProgress(deps.chatHistoryManager, runner, turnSessionId);
        } else {
          deps.chatHistoryManager.updatePermissionCard(turnSessionId, event.requestId, {
            phase,
            ...(event.remembered ? { remembered: true } : {}),
          });
        }
        runner.emitMessage({
          type: "permission_resolved",
          sessionId: turnSessionId,
          requestId: event.requestId,
          phase,
          ...(event.remembered ? { remembered: true } : {}),
        });

        runner.awaitingPermissionIds.delete(event.requestId);
        if (runner.awaitingPermissionIds.size === 0) {
          deps.sseBroadcast("session_attention", {
            sessionId: turnSessionId,
            awaitingPermission: false,
          });
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
      const wireEvent = opts.capturedSessionId
        ? projectAgentEventForWire(opts.capturedSessionId, event, (id) => toolTracker.getToolName(id))
        : event;
      emitToViewers({ type: "agent_event", event: wireEvent });
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
        emitToViewers({ type: "session_started", session });
        deps.sseBroadcast("session_started", { session });
      }
      if (opts.isNewSession) {
        console.log(`[persist-user] agent_init session=${turnSessionId} (isNewSession branch)`);
        opts.persistUserMessage(turnSessionId);
      }

      if (event.model) {
        turnModel = event.model;
        emitToViewers({
          type: "model_info",
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
            "Guarded mode isn't available for this account or model, so this turn is running in auto mode (no command safety check). It needs a Max, Team, or Enterprise plan and a Sonnet or Opus model.",
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
        opts.adoptsCliStartedTurns && sawTurnResult && runner && !runner.running
        && !event.parentToolUseId
      ) {
        adoptCliStartedTurn("post-result assistant output");
      }

      persistAgentSessionIdIfReady();

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
      }

      if (runner) {
        observeVoiceNotes(runner, toolBlocks, deps.deliverVoiceNote);
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
      const toolResults = extractToolResults(event);

      if (toolResults.length > 0) toolTracker.reportMcpCrashesFromResults(toolResults);

      if (event.parentToolUseId && runner && toolResults.length > 0) {
        attachSubagentToolResults(runner, event.parentToolUseId, toolResults);
        return;
      }

      if (runner) runner.needsNewMessageGroup = true;

      if (toolResults.length > 0 && runner) {
        attachToolResultsToGroup(runner, toolResults);
      }

      const usageSessionId = opts.capturedSessionId;
      if (usageSessionId) {
        const inProgressMessages = buildTurnMessages(
          runner?.chatMessageGroups ?? [],
          runner?.steeredMessages ?? [],
          runner?.recordedCards ?? [],
          { inProgress: true },
        );
        deps.chatHistoryManager.replaceInProgress(usageSessionId, inProgressMessages);
        if (runner) markMessagesCommitted(runner.committedBodyIds, inProgressMessages);
        if (runner) runner.lastPersistedBufferIndex = runner.getTurnEventBuffer().length;
      }
    }

    if (event.type === "agent_result") {
      const turnSessionId = opts.capturedSessionId;
      if (turnSessionId) {
        if (!missingConversationDetected) {
          deps.sessionManager.setAgentSessionId(turnSessionId, event.sessionId);
          agentSessionIdPersisted = true;
        }
        deps.sessionManager.track(turnSessionId);
        deps.sseBroadcast("session_list", { sessions: deps.sessionManager.list() });
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

      if (event.contextWindow && turnModel) {
        emitToViewers({
          type: "model_info",
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
        const resolvedCost = resolveTurnCost({
          harnessId: agent.agentId,
          attribution: turnAttribution,
          reportedCostUsd: event.cost?.totalUsd,
          tokens: {
            input: event.tokens?.input,
            output: event.tokens?.output,
            cacheRead: event.tokens?.cacheRead,
            cacheWrite: event.tokens?.cacheWrite,
          },
        });
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
            costSource: resolvedCost.costSource,
            // Preserve cumulative continuity across billing-mode changes.
            ...(event.cost?.totalUsd !== undefined
              ? { cumulativeSnapshot: event.cost.totalUsd }
              : {}),
            ...(turnAttribution ? { attribution: turnAttribution } : {}),
            ...(opts.getCapturedRouteId?.()
              ? { credentialRouteId: opts.getCapturedRouteId()! }
              : {}),
          },
        );
        if (turnAttribution) {
          perTurnUsage.billingMode = turnAttribution.billingMode;
        }
        if (turnAttribution?.billingMode === "sub") {
          perTurnUsage.atApiRatesUsd = costFromRates(turnAttribution.rates, {
            input: event.tokens?.input,
            output: event.tokens?.output,
            cacheRead: event.tokens?.cacheRead,
            cacheWrite: event.tokens?.cacheWrite,
          });
        }
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

      const finalMessages = buildTurnMessages(
        runner?.chatMessageGroups ?? [],
        runner?.steeredMessages ?? [],
        runner?.recordedCards ?? [],
        { inProgress: false },
      );
      deps.chatHistoryManager.replaceInProgress(usageSessionId, finalMessages);
      deps.chatHistoryManager.finalizeInProgress(usageSessionId);
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

      const turnErrored = Boolean((event as { error?: unknown }).error) && !runner?.wasInterrupted;
      if (runner) runner.lastTurnErrored = turnErrored;
      if (turnSessionId) deps.sessionManager.setLastTurnErrored(turnSessionId, turnErrored);

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
    if (turnSessionId) {
      const partialMessages = buildTurnMessages(
        runner?.chatMessageGroups ?? [],
        [],
        runner?.recordedCards ?? [],
        { inProgress: false },
      );
      deps.chatHistoryManager.replaceInProgress(turnSessionId, partialMessages);
      deps.chatHistoryManager.finalizeInProgress(turnSessionId);
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
      runner.lastTurnErrored = true;
      if (turnSessionId) deps.sessionManager.setLastTurnErrored(turnSessionId, true);
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
