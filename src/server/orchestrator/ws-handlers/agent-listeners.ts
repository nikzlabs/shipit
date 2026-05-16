import type { WsServerMessage, ClaudeContentBlockText, ClaudeContentBlockToolUse, TurnUsage } from "../../shared/types.js";
import type { AgentEvent, AgentProcess } from "../../shared/types.js";
import type { ConnectionCtx, RunnerCtx, AppCtx } from "./types.js";
import type { ChatMessageGroup, ToolResultEntry } from "../session-runner.js";
import { resolveRunner } from "./resolve-runner.js";
import { getContextWindowForModel, DEFAULT_CONTEXT_WINDOW_TOKENS } from "../../shared/agent-registry.js";

/**
 * Find the chat message group that contains the given tool_use id (either in
 * its top-level toolUse list, or — for nested subagents — in a subagentEvent's
 * toolUse list). Used to attach subagent events to the correct group so they
 * render under the parent Task tool. (109 — subagent transparency)
 */
function findGroupContainingTool(
  groups: ChatMessageGroup[],
  toolUseId: string,
): ChatMessageGroup | undefined {
  // Iterate newest-first since subagent events typically reference a recent tool.
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    if (g.toolUse.some((t) => t.id === toolUseId)) return g;
    // Also handle nested subagents-of-subagents: look inside existing subagentEvents.
    for (const ev of g.subagentEvents ?? []) {
      if (ev.kind === "assistant" && ev.toolUse.some((t) => t.id === toolUseId)) return g;
    }
  }
  return undefined;
}

/** Full handler context — send-message handlers need all three sub-contexts. */
type FullCtx = ConnectionCtx & RunnerCtx & AppCtx;

/**
 * Default context window in tokens. Kept as a re-export for legacy call
 * sites; per-model windows are resolved via `getContextWindowForModel`.
 */
export const CONTEXT_WINDOW_TOKENS = DEFAULT_CONTEXT_WINDOW_TOKENS;

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
 * Pattern for MCP tool names: `mcp__<server>__<tool>`. Capture group 1 is the
 * server namespace, used to attribute a failed tool call back to a specific
 * configured MCP server (docs/088 mid-session crash detection). `<server>` is
 * lowercase alphanumeric per the same validation as
 * `services/mcp.ts#NAME_RE`; `<tool>` can include underscores. The outer
 * anchors guarantee a full-name match so an unrelated tool that happens to
 * contain `mcp__` in its arguments doesn't trigger crash attribution.
 */
const MCP_TOOL_NAME_RE = /^mcp__([a-z][a-z0-9]*)__/;

/**
 * Truncate a tool-result error payload for inclusion in the per-server
 * `crashed` reason string. Tool errors can be megabytes (stack traces,
 * dumped JSON), and we forward the reason verbatim to the UI badge —
 * cap it so a single bad tool call can't bloat the WS message or the
 * Settings panel hover state.
 */
function summarizeCrashReason(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return "tool call failed";
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? trimmed;
  const MAX = 240;
  return firstLine.length > MAX ? `${firstLine.slice(0, MAX - 1)}…` : firstLine;
}

/**
 * Wire up common agent event listeners shared across send_message,
 * answer_question, and the queued-message replay inside runAgentWithMessage.
 */
export function wireAgentListeners(
  ctx: FullCtx,
  agent: AgentProcess,
  opts: {
    isNewSession: boolean;
    persistUserMessage: (sessionId: string) => void;
    fallbackTitle?: string;
    /**
     * Session ID captured at turn start — immune to session switches. Always
     * set in production: both `runAgentWithMessage` and `handleAnswerQuestion`
     * capture this from `ctx.getActiveAppSessionId()`, which is the URL-
     * derived session ID on the per-session WS route. Marked optional only
     * for ergonomics in the rare test that wires listeners directly.
     */
    capturedSessionId?: string;
  },
): void {
  if (!opts.capturedSessionId) {
    // The previous fallback in the agent_init branch called
    // `setActiveAppSessionId(event.sessionId)` — but `event.sessionId` is the
    // Claude CLI's internal session_id (e.g. `agent-init-1`), not an app
    // session UUID. Setting it as the active app session is always wrong.
    // Per-session WS handlers always pass capturedSessionId, so reaching
    // this state means the call site is buggy — fail loudly rather than
    // silently mis-routing the session.
    throw new Error("wireAgentListeners requires opts.capturedSessionId — per-session WS routes always set it");
  }
  // Capture runner at wire time — this direct reference survives WS disconnects.
  // `resolveRunner` prefers the registry (keyed by the captured session ID),
  // so the runner is correct even when the originating WS has already
  // disconnected by the time this is invoked from a queue-drained recursive
  // turn. Mutate this captured reference directly throughout the listeners.
  const runner = resolveRunner(ctx, opts.capturedSessionId);
  // Capture the model used for this turn — sourced from `agent_init` (what the
  // CLI actually picked) or falls back to the user-selected model. Used on
  // `agent_result` to attach the model to per-turn usage so the dial can
  // re-target context window when the user switches models mid-session.
  let turnModel: string | undefined = ctx.getSelectedModel();
  // Helper: emit to all viewers via runner, or fall back to ctx.send
  const emitToViewers = (msg: WsServerMessage) => {
    if (runner) {
      runner.emitMessage(msg);
    } else {
      ctx.send(msg);
    }
  };

  // ---- MCP mid-turn crash detection (docs/088) ----
  //
  // The CLI's init event covers cold-start liveness (ClaudeAdapter →
  // `mcp_status`), but doesn't say anything when a server dies mid-turn.
  // We can recover that signal from tool-result errors: every MCP tool call
  // is named `mcp__<server>__<tool>`, so an `is_error: true` result whose
  // parent `tool_use_id` resolved to an MCP tool means that server failed
  // *while serving the agent*, which is the user-visible definition of
  // "crashed". We:
  //   1. Record `id → name` for every tool_use we see this turn (including
  //      subagent ones — Task children dispatch MCP tools too).
  //   2. On `is_error: true` tool_result, look up the name, extract the
  //      server, dedupe per-turn-per-server, and emit `mcp_server_status`
  //      with `state: "crashed"` and a short reason derived from the error
  //      content. Dedupe avoids spamming one badge per failed tool call when
  //      the agent retries.
  //
  // McpStore.applyStatus is last-write-wins, so the next successful init
  // event from a future turn naturally clears the badge back to `loaded`.
  const toolUseIdToName = new Map<string, string>();
  const crashedServersThisTurn = new Set<string>();
  const recordToolUses = (
    blocks: readonly { id: string; name: string }[],
  ) => {
    for (const block of blocks) toolUseIdToName.set(block.id, block.name);
  };
  const reportMcpCrashesFromResults = (results: ToolResultEntry[]) => {
    for (const result of results) {
      if (!result.isError) continue;
      const toolName = toolUseIdToName.get(result.toolUseId);
      if (!toolName) continue;
      const match = MCP_TOOL_NAME_RE.exec(toolName);
      if (!match) continue;
      const serverName = match[1];
      if (crashedServersThisTurn.has(serverName)) continue;
      crashedServersThisTurn.add(serverName);
      emitToViewers({
        type: "mcp_server_status",
        sessionId: opts.capturedSessionId!,
        name: serverName,
        state: "crashed",
        reason: summarizeCrashReason(result.content),
      });
    }
  };

  agent.on("log", (source: string, text: string) => {
    ctx.broadcastLog(source as "stderr" | "stdout" | "server", text);
  });

  agent.on("event", (event: AgentEvent) => {
    emitToViewers({ type: "agent_event", event });

    if (event.type === "agent_init") {
      // Use the session ID captured at turn start — immune to session switches.
      // Guaranteed non-null by the assert at function entry.
      const turnSessionId = opts.capturedSessionId!;
      // Record "Agent process started" only when the agent actually
      // starts emitting events — the unconditional broadcastLog at the
      // run() call site fired even when the worker rejected a duplicate
      // /agent/start (HTTP 409), producing misleading multi-start log
      // entries when the orchestrator's defensive flow couldn't catch
      // a race. agent_init is emitted by both local adapters and the
      // proxy, so this works uniformly across runtime modes.
      ctx.broadcastLog("server", "Agent process started");
      ctx.sessionManager.setAgentSessionId(turnSessionId, event.sessionId);
      const session = ctx.sessionManager.get(turnSessionId);
      if (session) {
        emitToViewers({ type: "session_started", session });
        ctx.sseBroadcast("session_started", { session });
      }
      if (opts.isNewSession) {
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
    }

    if (event.type === "agent_assistant") {
      const text = (event.content ?? [])
        .filter((b): b is ClaudeContentBlockText => b.type === "text")
        .map((b) => b.text)
        .join("");

      const toolBlocks = (event.content ?? [])
        .filter((b): b is ClaudeContentBlockToolUse => b.type === "tool_use");

      // Record every tool_use this turn — including subagent (Task) ones,
      // since their children dispatch MCP tools whose failures we still want
      // attributed to the right server. See `recordToolUses` block at the
      // top of this function (docs/088 mid-turn crash detection).
      if (toolBlocks.length > 0) recordToolUses(toolBlocks);

      // Subagent (Task) events carry parentToolUseId. Route them under the
      // group that contains the parent Task tool, *not* into the main flow —
      // otherwise nested tool calls would corrupt the parent conversation.
      // (109 — subagent transparency)
      if (event.parentToolUseId && runner) {
        const groups = runner.chatMessageGroups;
        const parentGroup = findGroupContainingTool(groups, event.parentToolUseId);
        if (parentGroup) {
          parentGroup.subagentEvents = [
            ...(parentGroup.subagentEvents ?? []),
            { kind: "assistant", parentToolUseId: event.parentToolUseId, text, toolUse: toolBlocks },
          ];
          runner.chatMessageGroups = groups;
        }
        return;
      }

      if (text && runner) {
        runner.turnSummary = text;
        runner.accumulatedText += text;
      }

      if (toolBlocks.length > 0 && runner) {
        runner.accumulatedToolUse = [...runner.accumulatedToolUse, ...toolBlocks];
      }

      // Track message groups for chat history (split at tool-result boundaries)
      if ((text || toolBlocks.length > 0) && runner) {
        const groups = runner.chatMessageGroups;
        // Standalone tools (ExitPlanMode, AskUserQuestion) should merge with the
        // preceding group to keep plan text together with the PlanApproval card.
        // Without this, ExitPlanMode ends up in a separate message group with
        // empty text when the agent does research between writing the plan and
        // calling ExitPlanMode.
        const STANDALONE_MERGE = new Set(["ExitPlanMode", "AskUserQuestion"]);
        const isStandaloneOnly = !text && toolBlocks.length > 0
          && toolBlocks.every((t) => STANDALONE_MERGE.has(t.name));
        if (runner.needsNewMessageGroup && isStandaloneOnly && groups.length > 0) {
          // Merge standalone tools with previous group; leave needsNewMessageGroup
          // true so the next non-standalone event starts a fresh group.
          const last = groups[groups.length - 1];
          last.toolUse.push(...toolBlocks);
        } else if (runner.needsNewMessageGroup || groups.length === 0) {
          groups.push({ text, toolUse: [...toolBlocks] });
          runner.needsNewMessageGroup = false;
        } else {
          const last = groups[groups.length - 1];
          last.text += text;
          last.toolUse.push(...toolBlocks);
        }
        runner.chatMessageGroups = groups;
      }

      // AskUserQuestion blocking: the Claude CLI in `-p` (headless) mode has no
      // way to actually wait for a real user answer — without `--input-format
      // stream-json` there's no bidirectional channel — so the CLI auto-resolves
      // the tool call (typically with an empty/"no user" result) and the model
      // continues with whatever it had planned. From the user's POV the
      // AskUserQuestion card appears AND the agent has already moved on without
      // them pressing anything.
      //
      // Fix: when we see an AskUserQuestion tool_use at the top level, interrupt
      // the CLI so it can't act on the auto-resolved result. The card stays
      // rendered (we've already emitted the event and stored the message group).
      // When the user picks an answer, `handleAnswerQuestion` resumes with
      // `--resume` and the answer as the next prompt.
      //
      // We set `wasInterrupted = true` so the existing post-turn flow (see
      // agent-execution.ts) suppresses the spurious "exited without result"
      // error and skips the queue drain. Only fires for top-level events —
      // parentToolUseId-carrying (subagent) events have already returned above.
      if (runner && toolBlocks.some((t) => t.name === "AskUserQuestion")) {
        runner.wasInterrupted = true;
        agent.interrupt();
        ctx.broadcastLog("server", "Agent interrupted: waiting for AskUserQuestion answer");
      }
    }

    // Mark a message-group boundary when tool results arrive so the
    // next agent_assistant starts a new chat history entry.
    if (event.type === "agent_tool_result") {
      const toolResults = extractToolResults(event);

      // docs/088 mid-turn crash detection: scan tool results for failures
      // attributable to a configured MCP server. Done BEFORE the subagent
      // routing fork below so failures inside Task children are caught too.
      // No-op when there are no errors / no MCP-prefixed names — cheap to
      // call on every result block.
      if (toolResults.length > 0) reportMcpCrashesFromResults(toolResults);

      // Subagent tool_result events: attach to the parent group's subagentEvents
      // and do NOT split the main message group. (109 — subagent transparency)
      if (event.parentToolUseId && runner && toolResults.length > 0) {
        const groups = runner.chatMessageGroups;
        const parentGroup = findGroupContainingTool(groups, event.parentToolUseId);
        if (parentGroup) {
          parentGroup.subagentEvents = [
            ...(parentGroup.subagentEvents ?? []),
            { kind: "tool_result", parentToolUseId: event.parentToolUseId, toolResults },
          ];
          runner.chatMessageGroups = groups;
        }
        return;
      }

      if (runner) runner.needsNewMessageGroup = true;

      // Attach tool results to the current message group
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
            subagentEvents: g.subagentEvents?.length ? g.subagentEvents : undefined,
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

      // If the backend reported the real context window for this turn's
      // model (e.g. Opus 4.7 → 1_000_000), re-emit `model_info` with the
      // authoritative value. This overrides whatever `agent_init` derived
      // from the static `MODEL_CONTEXT_WINDOWS` map.
      if (event.contextWindow && turnModel) {
        emitToViewers({
          type: "model_info",
          model: turnModel,
          contextWindowTokens: event.contextWindow,
        });
      }

      // Build the per-turn usage record for the live `turn_usage_update` emit.
      // Per-turn data is no longer attached to chat-history messages — the
      // canonical per-turn series is owned by `UsageManager` and rehydrated
      // from there via `GET /api/sessions/:id/history` (see B in the
      // ContextDial cost-display unification).
      let perTurnUsage: TurnUsage | undefined;
      if (event.tokens?.input !== undefined || event.tokens?.output !== undefined || event.cost?.totalUsd !== undefined) {
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
        // `contextTokens` is the real context-window occupancy at turn end
        // (last iteration's input + cache). Distinct from `inputTokens +
        // cacheRead + cacheCreate`, which sums over every iteration and
        // dramatically overstates context for tool-heavy turns.
        if (event.contextTokens !== undefined) perTurnUsage.contextTokens = event.contextTokens;
      }

      if (event.cost?.totalUsd !== undefined) {
        ctx.usageManager.record(
          usageSessionId,
          event.cost.totalUsd,
          event.durationMs ?? 0,
          event.tokens?.input,
          event.tokens?.output,
          {
            cacheRead: event.tokens?.cacheRead,
            cacheCreate: event.tokens?.cacheWrite,
            model: turnModel,
            contextTokens: event.contextTokens,
          },
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
            cumulativeOutputTokens: tokenTotals?.cumulativeOutputTokens,
          });
          if (perTurnUsage) {
            emitToViewers({
              type: "turn_usage_update",
              sessionId: sessionUsage.sessionId,
              turn: perTurnUsage,
              totalCostUsd: sessionUsage.totalCostUsd,
              turnCount: sessionUsage.turnCount,
            });
          }
        }
      } else if (perTurnUsage) {
        // Tokens but no cost — still notify the dial.
        emitToViewers({
          type: "turn_usage_update",
          sessionId: usageSessionId,
          turn: perTurnUsage,
          totalCostUsd: 0,
          turnCount: 0,
        });
      }

      // Persist each message group as a separate assistant entry so that
      // reloaded chat history shows the same message boundaries as live
      // streaming. Per-turn usage is no longer attached to the last group —
      // the per-turn cost/token series lives in `usage_turns` and is fetched
      // alongside chat history by the `/history` HTTP endpoint.
      const groups = runner?.chatMessageGroups ?? [];
      const persistableGroups = groups.filter((g) => g.text || g.toolUse.length > 0);
      const finalMessages = persistableGroups.map((g) => ({
        role: "assistant" as const,
        text: g.text,
        toolUse: g.toolUse.length > 0 ? g.toolUse : undefined,
        toolResults: g.toolResults?.length ? g.toolResults : undefined,
        subagentEvents: g.subagentEvents?.length ? g.subagentEvents : undefined,
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
      // Preserve whatever partial turn the agent produced before it errored.
      // Mirrors the agent_result path: persist the accumulated message groups
      // and finalize them, *then* append the error message. The old code
      // called clearInProgress() here, which deleted the entire in-progress
      // turn — so a crash mid-turn wiped all of the agent's work from the UI
      // on the next history load.
      const groups = runner?.chatMessageGroups ?? [];
      const persistableGroups = groups.filter((g) => g.text || g.toolUse.length > 0);
      const partialMessages = persistableGroups.map((g) => ({
        role: "assistant" as const,
        text: g.text,
        toolUse: g.toolUse.length > 0 ? g.toolUse : undefined,
        toolResults: g.toolResults?.length ? g.toolResults : undefined,
        subagentEvents: g.subagentEvents?.length ? g.subagentEvents : undefined,
      }));
      ctx.chatHistoryManager.replaceInProgress(turnSessionId, partialMessages);
      ctx.chatHistoryManager.finalizeInProgress(turnSessionId);
      ctx.chatHistoryManager.append(turnSessionId, {
        role: "assistant",
        text: `Error: ${err.message}`,
        isError: true,
      });
    }
    // Clear runner state so a stuck `running=true` doesn't make this runner
    // permanently undisposable. Some adapter paths emit `error` without a
    // follow-up `done` (e.g. spawn failure in claude.ts:94, agent_error SSE
    // event from the worker without a subsequent agent_done) — without this
    // reset, `runner.dispose()`'s running-guard would refuse forever.
    // Setting running=false also lets the periodic idle enforcer reclaim the
    // session normally. Emit `idle` if appropriate so post-cleanup proceeds.
    if (runner) {
      runner.setAgent(null);
      runner.running = false;
      if (turnSessionId) {
        emitToViewers({
          type: "session_status",
          sessionId: turnSessionId,
          running: false,
          queueLength: runner.queueLength,
          error: `Agent process error: ${err.message}`,
        });
      }
      runner.onAgentFinished();
    }
  });
}
