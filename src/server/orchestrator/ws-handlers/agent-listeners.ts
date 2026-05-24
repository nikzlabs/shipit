import type { WsServerMessage, ClaudeContentBlockText, ClaudeContentBlockToolUse, TurnUsage, PermissionMode } from "../../shared/types.js";
import type { AgentEvent, AgentProcess } from "../../shared/types.js";
import type { AgentId, SubscriptionLimitsMap } from "../../shared/types.js";
import type { ConnectionCtx, RunnerCtx, AppCtx } from "./types.js";
import type { ChatMessageGroup, ToolResultEntry, SteeredMessage } from "../session-runner.js";
import type { PersistedMessage } from "../chat-history.js";
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

const AGENT_LIMIT_LABELS: Record<AgentId, string> = {
  claude: "Claude",
  codex: "Codex",
};

/**
 * Upstream agent CLIs can report the generic "org monthly usage limit" even
 * when ShipIt's subscription badge has a fresh exhausted 5h-window snapshot.
 * Correct only that known mismatch; without an exhausted session window, keep
 * the upstream text intact.
 */
export function normalizeAgentUsageLimitError(
  agentId: AgentId,
  message: string,
  limits: SubscriptionLimitsMap | undefined,
): string {
  if (!/monthly usage limit/i.test(message)) return message;

  const sessionLimit = limits?.[agentId]?.session;
  if (!sessionLimit || sessionLimit.usedPct < 100) return message;

  const reset = new Date(sessionLimit.resetAt);
  const resetText = Number.isNaN(reset.getTime())
    ? sessionLimit.resetAt
    : reset.toISOString();
  const label = AGENT_LIMIT_LABELS[agentId] ?? agentId;
  return `You've hit ${label}'s 5h usage limit. It resets at ${resetText}.`;
}

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
 * Build the ordered list of in-progress messages for a turn, interleaving any
 * live-steered user messages (docs/140) at their true position among the
 * assistant message groups.
 *
 * `replaceInProgress` deletes every `in_progress=1` row and re-inserts this
 * list, so the assistant rows are reborn with fresh (higher) ids on every
 * call. A steered user message persisted out-of-band (via `append`) keeps its
 * original early id and therefore collapses up next to the turn's first user
 * message on reload. Folding the steers into the same rebuilt batch — anchored
 * by `afterGroupIndex` (the count of persistable groups when the steer
 * arrived) — keeps them at the exact spot the user sent them.
 *
 * When `inProgress` is true the rows participate in the next delete/reinsert
 * cycle; the final (agent_result) call passes false so the rows are written
 * permanently before `finalizeInProgress`.
 */
export function buildTurnMessages(
  groups: ChatMessageGroup[],
  steered: SteeredMessage[],
  opts: { inProgress: boolean },
): PersistedMessage[] {
  const persistable = groups.filter((g) => g.text || g.toolUse.length > 0);
  const out: PersistedMessage[] = [];
  const flag = opts.inProgress ? { inProgress: true as const } : {};

  const emitSteersAt = (index: number) => {
    for (const s of steered) {
      if (s.afterGroupIndex === index) out.push({ role: "user", text: s.text, ...flag });
    }
  };

  for (let i = 0; i < persistable.length; i++) {
    emitSteersAt(i);
    const g = persistable[i];
    out.push({
      role: "assistant",
      text: g.text,
      toolUse: g.toolUse.length > 0 ? g.toolUse : undefined,
      toolResults: g.toolResults?.length ? g.toolResults : undefined,
      subagentEvents: g.subagentEvents?.length ? g.subagentEvents : undefined,
      ...flag,
    });
  }
  // Steers anchored at or beyond the final group count land after everything.
  // The `>=` clamp guards against an anchor that outran the persistable groups
  // (e.g. the anchoring group never produced persistable content).
  for (const s of steered) {
    if (s.afterGroupIndex >= persistable.length) out.push({ role: "user", text: s.text, ...flag });
  }
  return out;
}

/**
 * Record a live-steered user message on the runner, anchored after the
 * assistant groups that have produced persistable content so far. The anchor
 * is what `buildTurnMessages` uses to re-interleave the message at its true
 * transcript position on every in-progress rebuild (docs/140).
 */
export function recordSteeredMessage(
  runner: { chatMessageGroups: ChatMessageGroup[]; steeredMessages: SteeredMessage[] },
  text: string,
): void {
  const afterGroupIndex = runner.chatMessageGroups.filter((g) => g.text || g.toolUse.length > 0).length;
  runner.steeredMessages = [...runner.steeredMessages, { afterGroupIndex, text }];
  // docs/140 diag — capture the steered-message inject point. Pairs with the
  // `[persist-user]` logs to confirm whether the same user text was both
  // appended (via persistUserMessage) and injected into the in-progress batch
  // (via this path) during one user-send — the suspected double-bubble cause.
  console.log(
    `[steered] recordSteeredMessage afterGroupIndex=${afterGroupIndex} steered.len=${runner.steeredMessages.length} text=${JSON.stringify(text.slice(0, 60))}`,
  );
}

/**
 * Persist the current turn's groups + steered messages as the in-progress set.
 * Shared by the steer handler (so a mid-turn injection is saved immediately)
 * and the tool-result boundary in `wireAgentListeners`.
 */
export function persistTurnInProgress(
  chatHistoryManager: { replaceInProgress(sessionId: string, messages: PersistedMessage[]): void },
  runner: { chatMessageGroups: ChatMessageGroup[]; steeredMessages: SteeredMessage[] },
  sessionId: string,
): void {
  chatHistoryManager.replaceInProgress(
    sessionId,
    buildTurnMessages(runner.chatMessageGroups, runner.steeredMessages, { inProgress: true }),
  );
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
 * True when an AskUserQuestion tool_use carries a non-empty `questions` array.
 * Used to gate the "interrupt the CLI so it can't auto-resolve the call"
 * behavior: an input without `questions` is rejected by the CLI's own input
 * validator (InputValidationError flows back as a tool_result), and the client
 * can't render the card without it either — so interrupting on a malformed
 * call would just kill the turn before the model can self-correct.
 */
function isWellFormedAskUserQuestion(t: ClaudeContentBlockToolUse): boolean {
  if (t.name !== "AskUserQuestion") return false;
  const questions = (t.input as { questions?: unknown }).questions;
  return Array.isArray(questions) && questions.length > 0;
}

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
    /**
     * The permission mode this turn actually requested from the CLI (docs/138),
     * AFTER any guarded→auto downgrade. When this is `"guarded"`, the
     * `agent_init` handler reads `init.permissionMode` to confirm the
     * classifier engaged (`"auto"`) and, if not, sets the runner's volatile
     * `guardedUnavailable` flag and emits an inline fallback notice. Undefined /
     * non-guarded turns skip the check entirely.
     */
    requestedPermissionMode?: PermissionMode;
    /**
     * Called from the `error` handler after the runner has been cleaned up.
     * `runAgentWithMessage` uses this to drain the next queued message so a
     * transient /agent/start failure (e.g. 409 race) doesn't strand the rest
     * of the queue. Awaited so any recursive turn start is sequenced inside
     * the error handler.
     */
    onError?: () => Promise<void>;
    /**
     * True when this turn is being run on a persistent streaming agent
     * (live steering active, docs/140). In streaming mode the CLI can
     * genuinely block on `AskUserQuestion` (the user's answer flows back via
     * `sendUserMessage`/NDJSON on stdin), so the orchestrator must NOT
     * interrupt on the tool — that would tear down the running turn instead
     * of letting the user steer their answer in.
     */
    useStreaming?: boolean;
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

  // `agent_init` fires once per Claude CLI "session" — i.e. once per top-level
  // turn AND once per Task subagent (each subagent gets its own session_id and
  // emits its own init). The log entry is meant to mark the agent process
  // actually coming up, not every internal session boundary, so gate it to the
  // first init we see for this wired-agent invocation. Without the flag, a turn
  // that dispatches a few subagents prints a wall of misleading "Agent process
  // started" entries even though only one process started.
  let hasLoggedAgentStart = false;

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

  agent.on("event", (rawEvent: AgentEvent) => {
    let event = rawEvent;
    // Subscription rate-limits are account-wide telemetry, not chat content:
    // route them into the limits badge (which broadcasts its own SSE) and
    // stop — forwarding as an `agent_event` would just be noise for the chat
    // message grouping. See CodexLimitsProvider / docs/135.
    if (event.type === "agent_rate_limits") {
      ctx.recordCodexRateLimits?.(event.session, event.weekly);
      return;
    }

    if (event.type === "agent_result" && event.error) {
      event = {
        ...event,
        error: normalizeAgentUsageLimitError(
          agent.agentId,
          event.error,
          ctx.getSubscriptionLimitsSnapshot?.(),
        ),
      };
    }

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
      // proxy, so this works uniformly across runtime modes. Gated to
      // the first init per turn — see the `hasLoggedAgentStart` comment
      // above for why subsequent inits (subagents, streaming turn-2)
      // must not re-log.
      if (!hasLoggedAgentStart) {
        hasLoggedAgentStart = true;
        ctx.broadcastLog("server", "Agent process started");
      }
      ctx.sessionManager.setAgentSessionId(turnSessionId, event.sessionId);
      const session = ctx.sessionManager.get(turnSessionId);
      if (session) {
        emitToViewers({ type: "session_started", session });
        ctx.sseBroadcast("session_started", { session });
      }
      if (opts.isNewSession) {
        // docs/140 diag — see comment in agent-execution.ts persistUserMessage.
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

      // docs/138 — guarded-mode runtime availability detection. The init
      // event's `permissionMode` is the authoritative signal: `"auto"` means
      // the classifier engaged. We only check when this turn actually
      // requested guarded; for `auto`/`plan` the field is irrelevant.
      if (opts.requestedPermissionMode === "guarded" && runner) {
        if (event.permissionMode === "auto") {
          // Engaged. Clear any stale unavailable flag (e.g. an admin
          // re-enabled auto mode since the last failed attempt this session).
          runner.guardedUnavailable = false;
        } else {
          // Requested but not engaged → non-transient unavailable (plan / admin
          // lock / unsupported model). The CLI already dropped to default for
          // this turn, so we let it complete in auto-equivalent and just label
          // it. Set the volatile flag so subsequent turns silently send auto.
          runner.guardedUnavailable = true;
          emitToViewers({
            type: "system_notice",
            sessionId: turnSessionId,
            level: "warn",
            message:
              "Guarded mode isn't available for this account or model, so this turn is running in auto mode (no command safety check). It needs a Max, Team, or Enterprise plan and a Sonnet or Opus model.",
          });
        }
      }
    }

    if (event.type === "agent_assistant") {
      // Multiple text blocks within a single assistant event are distinct
      // preambles separated by tool_use blocks (common when a subagent runs
      // serial tool calls in one turn). Joining with "" runs them together
      // with no separator — "…cloaker.Now I have…". Use "\n\n" so each
      // preamble renders as its own paragraph under whitespace-pre-wrap.
      const text = (event.content ?? [])
        .filter((b): b is ClaudeContentBlockText => b.type === "text")
        .map((b) => b.text)
        .join("\n\n");

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
      //
      // Gate on well-formed input: when the model emits an AskUserQuestion
      // call with missing/malformed `questions` (e.g. an empty input object,
      // which the CLI's input validator rejects with InputValidationError),
      // the AskUserQuestion card can't render at all — the client checks
      // `Array.isArray(tool.input.questions)` before rendering. Interrupting
      // here would kill the turn before the model gets the validation error
      // back, stranding the user with no card and no progress. Skip the
      // interrupt for malformed calls so the CLI's auto-resolved error reaches
      // the model and it can retry within the same turn.
      //
      // docs/140 — live steering: in streaming mode the CLI has a bidirectional
      // stdin channel and CAN genuinely block awaiting the user's answer (the
      // answer flows back via `sendUserMessage`/NDJSON on stdin instead of a
      // fresh `--resume` spawn). Interrupting here would tear down a turn that
      // would otherwise patiently wait — skip the hack and let the user steer
      // their answer in.
      if (
        runner
        && !opts.useStreaming
        && toolBlocks.some(isWellFormedAskUserQuestion)
      ) {
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

      // Persist all accumulated message groups as in-progress, interleaving any
      // live-steered user messages at their recorded position (docs/140).
      const usageSessionId = opts.capturedSessionId;
      if (usageSessionId) {
        const inProgressMessages = buildTurnMessages(
          runner?.chatMessageGroups ?? [],
          runner?.steeredMessages ?? [],
          { inProgress: true },
        );
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

      // docs/138 — surface guarded-mode classifier blocks inline so a guarded
      // turn never fails silently. A single block doesn't abort (the model
      // re-routes); the CLI ends a headless run only after its 3-consecutive /
      // 20-total threshold, at which point the turn produces an early/empty
      // result with these denials populated. Either way we summarize the
      // blocked tool(s) and offer next steps. Model self-refusals are NOT
      // classifier denials and never reach this array.
      //
      // Gate on `requestedPermissionMode === "guarded"`: the CLI can populate
      // `permission_denials[]` in non-guarded turns too (e.g. headless `-p`
      // auto-resolves an `AskUserQuestion` call because there's no human to
      // answer), and attributing those to "Guarded mode" was misleading the
      // user. In `auto`/`plan` mode the classifier isn't engaged, so any
      // denials in the result event are not classifier blocks and we don't
      // surface this notice.
      if (
        event.permissionDenials?.length
        && turnSessionId
        && opts.requestedPermissionMode === "guarded"
      ) {
        const blockedTools = [...new Set(event.permissionDenials.map((d) => d.toolName))].join(", ");
        const count = event.permissionDenials.length;
        emitToViewers({
          type: "system_notice",
          sessionId: turnSessionId,
          level: "warn",
          message:
            `Guarded mode blocked ${count} action${count === 1 ? "" : "s"} (${blockedTools}) as potentially unsafe. ` +
            "Rephrase with a narrower scope, run the command yourself, or switch to auto mode for this action.",
        });
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
        // `contextTokens` is the real context-window occupancy at turn end
        // (last iteration's input + cache). Distinct from `inputTokens +
        // cacheRead + cacheCreate`, which sums over every iteration and
        // dramatically overstates context for tool-heavy turns.
        if (event.contextTokens !== undefined) perTurnUsage.contextTokens = event.contextTokens;
      }

      if (perTurnUsage) {
        // Some backends, including Codex app-server, report authoritative token
        // usage but no dollar cost. Persist those turns with a zero-dollar
        // value so session turn counts, token history, and rehydration still
        // work; do not estimate pricing here.
        ctx.usageManager.record(
          usageSessionId,
          perTurnUsage.costUsd,
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
      }

      // Persist each message group as a separate assistant entry so that
      // reloaded chat history shows the same message boundaries as live
      // streaming. Per-turn usage is no longer attached to the last group —
      // the per-turn cost/token series lives in `usage_turns` and is fetched
      // alongside chat history by the `/history` HTTP endpoint.
      const finalMessages = buildTurnMessages(
        runner?.chatMessageGroups ?? [],
        runner?.steeredMessages ?? [],
        { inProgress: false },
      );
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

    // Tear the failed turn down. An auth failure ends the turn, but a
    // persistent streaming agent (live steering) does NOT exit on a failed
    // result, so the worker never clears `this.agent` and the runner is left
    // with `running=true` — the next turn then 409s with "Agent already
    // running". Killing the worker agent + resetting runner state here makes
    // the failure recoverable without waiting for the defensive kill+restart
    // path. See docs/142 (Problem B1). Kill is fire-and-forget; the proxy
    // surfaces any failure via the Logs panel, not the chat.
    const turnSessionId = opts.capturedSessionId;
    agent.kill();
    if (runner) {
      runner.setAgent(null);
      runner.running = false;
      if (turnSessionId) {
        emitToViewers({
          type: "session_status",
          sessionId: turnSessionId,
          running: false,
          queueLength: runner.queueLength,
        });
      }
    }
  });

  agent.on("error", async (err: Error) => {
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

    // Drain the next queued message so a transient /agent/start failure
    // (e.g. 409 race with the previous turn's worker-side cleanup) doesn't
    // strand the rest of the queue. The drain helper will set running=true
    // and start a fresh agent when it shifts a message off.
    if (opts.onError) {
      try {
        await opts.onError();
      } catch (drainErr) {
        console.error("[agent] error-path drain failed:", drainErr);
      }
    }
  });
}
