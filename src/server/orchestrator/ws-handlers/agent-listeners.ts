import type { WsServerMessage, ClaudeContentBlockText, ClaudeContentBlockToolUse } from "../../shared/types.js";
import type { AgentEvent, AgentProcess } from "../../shared/types.js";
import type { ConnectionCtx, RunnerCtx, AppCtx } from "./types.js";
import type { ToolResultEntry } from "../session-runner.js";

/** Full handler context — send-message handlers need all three sub-contexts. */
type FullCtx = ConnectionCtx & RunnerCtx & AppCtx;

/** Context window size in tokens (same across all current model families). */
export const CONTEXT_WINDOW_TOKENS = 200_000;

/** Extract tool result entries from an agent_tool_result event. */
export function extractToolResults(event: AgentEvent): ToolResultEntry[] {
  const content = (event as { content?: unknown[] }).content ?? [];
  return content
    .filter((b): b is Record<string, unknown> =>
      typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "tool_result" && !!(b as Record<string, unknown>).tool_use_id)
    .map((b) => ({
      toolUseId: b.tool_use_id as string,
      content: typeof b.content === "string" ? b.content
        : (b.content === null || b.content === undefined) ? ""
        : JSON.stringify(b.content),
      isError: (b.is_error as boolean) ?? false,
    }));
}

/**
 * Wire up common agent event listeners shared across send_message,
 * answer_question, and the queued-message replay inside runClaudeWithMessage.
 */
export function wireAgentListeners(
  ctx: FullCtx,
  agent: AgentProcess,
  opts: {
    isNewSession: boolean;
    persistUserMessage: (sessionId: string) => void;
    fallbackTitle?: string;
    /** Session ID captured at turn start — immune to session switches. */
    capturedSessionId?: string;
  },
): void {
  // Capture runner at wire time — this direct reference survives WS disconnects.
  // After disconnect, ctx setters (which go through `attachedRunner`) become no-ops,
  // but the agent continues emitting events. All runner state mutations MUST use
  // this captured reference, not ctx, to ensure state is updated correctly.
  const runner = ctx.getRunner();
  // Helper: emit to all viewers via runner, or fall back to ctx.send
  const emitToViewers = (msg: WsServerMessage) => {
    if (runner) {
      runner.emitMessage(msg);
    } else {
      ctx.send(msg);
    }
  };

  agent.on("log", (source: string, text: string) => {
    ctx.broadcastLog(source as "stderr" | "stdout" | "server", text);
  });

  agent.on("event", (event: AgentEvent) => {
    emitToViewers({ type: "agent_event", event });

    if (event.type === "agent_init") {
      // Use the session ID captured at turn start — immune to session switches
      const turnSessionId = opts.capturedSessionId;
      if (turnSessionId) {
        ctx.sessionManager.setAgentSessionId(turnSessionId, event.sessionId);
        const session = ctx.sessionManager.get(turnSessionId);
        if (session) {
          emitToViewers({ type: "session_started", session });
          ctx.sseBroadcast("session_started", { session });
        }
        if (opts.isNewSession) {
          opts.persistUserMessage(turnSessionId);
        }
      } else {
        const title = opts.fallbackTitle ?? "New session";
        const session = ctx.sessionManager.track(event.sessionId, title);
        ctx.setActiveAppSessionId(event.sessionId);
        emitToViewers({ type: "session_started", session });
        ctx.sseBroadcast("session_started", { session });
        opts.persistUserMessage(event.sessionId);
      }

      if (event.model) {
        emitToViewers({
          type: "model_info",
          model: event.model,
          contextWindowTokens: CONTEXT_WINDOW_TOKENS,
        });
      }
    }

    if (event.type === "agent_assistant") {
      const text = (event.content ?? [])
        .filter((b): b is ClaudeContentBlockText => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (text && runner) {
        runner.turnSummary = text;
        runner.accumulatedText += text;
      }

      const toolBlocks = (event.content ?? [])
        .filter((b): b is ClaudeContentBlockToolUse => b.type === "tool_use");
      if (toolBlocks.length > 0 && runner) {
        runner.accumulatedToolUse = [...runner.accumulatedToolUse, ...toolBlocks];
      }

      // Track message groups for chat history (split at tool-result boundaries)
      if ((text || toolBlocks.length > 0) && runner) {
        const groups = runner.chatMessageGroups;
        if (runner.needsNewMessageGroup || groups.length === 0) {
          groups.push({ text, toolUse: [...toolBlocks] });
          runner.needsNewMessageGroup = false;
        } else {
          const last = groups[groups.length - 1];
          last.text += text;
          last.toolUse.push(...toolBlocks);
        }
        runner.chatMessageGroups = groups;
      }
    }

    // Mark a message-group boundary when tool results arrive so the
    // next agent_assistant starts a new chat history entry.
    if (event.type === "agent_tool_result") {
      if (runner) runner.needsNewMessageGroup = true;

      // Attach tool results to the current message group
      const toolResults = extractToolResults(event);
      if (toolResults.length > 0 && runner) {
        const groups = runner.chatMessageGroups;
        if (groups.length > 0) {
          const last = groups[groups.length - 1];
          last.toolResults = [...(last.toolResults ?? []), ...toolResults];
          runner.chatMessageGroups = groups;
        }
      }

      // Persist all accumulated message groups as in-progress
      const usageSessionId = opts.capturedSessionId;
      if (usageSessionId) {
        const groups = runner?.chatMessageGroups ?? [];
        const inProgressMessages = groups
          .filter((g) => g.text || g.toolUse.length > 0)
          .map((g) => ({
            role: "assistant" as const,
            text: g.text,
            toolUse: g.toolUse.length > 0 ? g.toolUse : undefined,
            toolResults: g.toolResults?.length ? g.toolResults : undefined,
            inProgress: true,
          }));
        ctx.chatHistoryManager.replaceInProgress(usageSessionId, inProgressMessages);
        if (runner) runner.lastPersistedBufferIndex = runner.getTurnEventBuffer().length;
      }
    }

    if (event.type === "agent_result") {
      const turnSessionId = opts.capturedSessionId;
      if (turnSessionId) {
        ctx.sessionManager.setAgentSessionId(turnSessionId, event.sessionId);
        ctx.sessionManager.track(turnSessionId);
        ctx.sseBroadcast("session_list", { sessions: ctx.sessionManager.list() });
      }

      const usageSessionId = turnSessionId ?? event.sessionId;
      if (event.cost?.totalUsd !== undefined) {
        ctx.usageManager.record(
          usageSessionId,
          event.cost.totalUsd,
          event.durationMs ?? 0,
          event.tokens?.input,
          event.tokens?.output,
        );
        const sessionUsage = ctx.usageManager.getSessionUsage(usageSessionId);
        if (sessionUsage) {
          const tokenTotals = ctx.usageManager.getSessionTokenTotals(usageSessionId);
          emitToViewers({
            type: "usage_update",
            sessionId: sessionUsage.sessionId,
            totalCostUsd: sessionUsage.totalCostUsd,
            totalDurationMs: sessionUsage.totalDurationMs,
            turnCount: sessionUsage.turnCount,
            lastTurnInputTokens: event.tokens?.input,
            lastTurnOutputTokens: event.tokens?.output,
            cumulativeInputTokens: tokenTotals?.cumulativeInputTokens,
          });
        }
      }

      // Persist each message group as a separate assistant entry so that
      // reloaded chat history shows the same message boundaries as live streaming.
      const groups = runner?.chatMessageGroups ?? [];
      const finalMessages = groups
        .filter((g) => g.text || g.toolUse.length > 0)
        .map((g) => ({
          role: "assistant" as const,
          text: g.text,
          toolUse: g.toolUse.length > 0 ? g.toolUse : undefined,
          toolResults: g.toolResults?.length ? g.toolResults : undefined,
        }));
      ctx.chatHistoryManager.replaceInProgress(usageSessionId, finalMessages);
      ctx.chatHistoryManager.finalizeInProgress(usageSessionId);
      if (runner) runner.lastPersistedBufferIndex = runner.getTurnEventBuffer().length;

      // Mark turn as complete immediately — don't wait for async post-turn
      // work (git commit, PR lifecycle) in the "done" handler. This closes
      // the timing window where a reconnecting viewer sees running=true.
      // Use runner directly (not ctx) so this works even after WS disconnect.
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

  agent.on("auth_required", () => {
    console.log("[server] Agent CLI requires authentication, starting OAuth flow");
    emitToViewers({ type: "auth_required" });
    ctx.authManager.startOAuthFlow();
  });

  agent.on("error", (err: Error) => {
    console.error("[agent] process error:", err.message);
    ctx.broadcastLog("server", `Agent process error: ${err.message}`);
    emitToViewers({ type: "error", message: `Agent process error: ${err.message}` });
    const turnSessionId = opts.capturedSessionId;
    if (turnSessionId) {
      ctx.chatHistoryManager.clearInProgress(turnSessionId);
      ctx.chatHistoryManager.append(turnSessionId, {
        role: "assistant",
        text: `Error: ${err.message}`,
        isError: true,
      });
    }
    if (runner) runner.setAgent(null);
  });
}
