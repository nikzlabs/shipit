import type { WsServerMessage, ClaudeContentBlockText, ClaudeContentBlockToolUse, TurnUsage, PermissionMode, WsLogEntry } from "../../shared/types.js";
import type { AgentEvent, AgentProcess } from "../../shared/types.js";
import type { AgentId, SubscriptionLimitsMap } from "../../shared/types.js";
import type { ChatMessageGroup, ToolResultEntry, SteeredMessage, RecordedChatCard, SessionRunnerInterface, QueuedMessage } from "../session-runner.js";
import type { ChatHistoryManager, PersistedMessage } from "../chat-history.js";
import type { SessionManager } from "../sessions.js";
import type { UsageManager } from "../usage.js";
import type { AuthManager } from "../agents/claude/auth-manager.js";
import type { AgentAuthManager } from "../agent-auth-manager.js";
import { getContextWindowForModel, DEFAULT_CONTEXT_WINDOW_TOKENS } from "../../shared/agent-registry.js";
import type { VoiceNotePayload, VoiceNoteSource } from "../../shared/types/voice-note-types.js";
import { hasAuthoredVoiceNoteThisTurn } from "../voice/voice-note-router.js";
import { emitChatCard } from "../chat-card-persistence.js";
import type { CompactionCard } from "../../shared/types.js";
import crypto from "node:crypto";

/**
 * Context-light dependency set for `wireAgentListeners`. Lifted out of the
 * WS handler context (`FullCtx = ConnectionCtx & RunnerCtx & AppCtx`) so that
 * non-WS callers — system-dispatched turns, the rebase conflict-resolution
 * driver, child-session spawns — can share the same listener implementation.
 *
 * Keep this list minimal: anything in here is something the listener actually
 * needs to do its job. New per-turn signals belong in `WireListenersOpts`,
 * not here.
 */
export interface AgentListenerDeps {
  sessionManager: SessionManager;
  chatHistoryManager: ChatHistoryManager;
  usageManager: UsageManager;
  authManager: AuthManager;
  /**
   * Per-agent auth manager map. The `auth_required` handler looks up the
   * turn's backend and calls `.start()` on the matching manager — so a
   * Codex turn that fails on auth kicks off the Codex device flow, not
   * Claude OAuth. Optional for tests; falls back to the legacy Claude-only
   * `authManager.startOAuthFlow()` when absent. (docs/155 Phase 2c)
   */
  authManagers?: Map<AgentId, AgentAuthManager>;
  /** App-level SSE broadcaster (session_list, session_started, etc.). */
  sseBroadcast: (event: string, data: unknown) => void;
  /** Append a line to the per-session log buffer. */
  broadcastLog: (source: WsLogEntry["source"], text: string) => void;
  /** Model the caller wants the turn to start with (before agent_init confirms). */
  getSelectedModel: () => string | undefined;
  /** Optional: push a fresh rate-limit snapshot (any agent) to the subscription badge. */
  recordAgentRateLimits?: (
    agentId: AgentId,
    session: { usedPct: number | null; resetAt: string } | null,
    weekly: { usedPct: number | null; resetAt: string } | null,
  ) => void;
  /** Optional: latest subscription-limits snapshot, used to reclassify generic CLI errors. */
  getSubscriptionLimitsSnapshot?: () => SubscriptionLimitsMap;
  /**
   * docs/153 — fire-and-forget nudge to the orchestrator-owned Claude OAuth
   * refresher. Triggered from the session-level `auth_required` handler so a
   * stale per-session token is healed for the next turn. Optional — local
   * runtime and tests omit it. Kept as a direct ref for non-WS callers
   * (credentials sync); the WS-side `auth_required` handler routes through
   * the agent-keyed {@link onAgentAuthRequired} table instead. (docs/155)
   */
  nudgeClaudeOAuthRefresh?: () => void;
  /**
   * docs/155 — per-agent dispatch for the WS-level `auth_required` event.
   * Each backend that needs a side effect on auth failure (Claude: nudge the
   * OAuth refresher; Codex: a future device-flow restart) registers itself
   * at app-DI time and the listener becomes agent-agnostic. Optional — no-op
   * if the agent has no registered hook.
   */
  onAgentAuthRequired?: (agentId: AgentId) => void;
  /**
   * docs/163 — deliver a voice note through the router. Used by the source
   * observer to emit a *derived* headline when the agent reaches an
   * `AskUserQuestion` / `ExitPlanMode` interrupt without having authored one
   * via the built-in `voice_note` tool first (the fallback floor). Optional —
   * absent in tests / minimal setups, in which case derivation is skipped.
   */
  deliverVoiceNote?: (
    payload: VoiceNotePayload,
    runner: SessionRunnerInterface,
    source: VoiceNoteSource,
  ) => void;
}

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
  if (!sessionLimit) return message;
  // usedPct is null when the provider hasn't reported utilization yet (Claude
  // CLI 2.1.140 below its warning thresholds — anthropics/claude-code#50518).
  // Without a number we can't claim the window is exhausted, so leave the
  // upstream "monthly usage limit" message intact.
  if (sessionLimit.usedPct === null || sessionLimit.usedPct < 100) return message;

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
 * live-steered user messages (docs/140) and recorded chat cards (voice notes
 * docs/163, bug-report cards docs/164, …) at their true position among the
 * assistant message groups.
 *
 * `replaceInProgress` deletes every `in_progress=1` row and re-inserts this
 * list, so the assistant rows are reborn with fresh (higher) ids on every
 * call. A steered user message — or a recorded card — persisted out-of-band
 * (via `append`) keeps its original early id and therefore collapses up next
 * to the turn's first user message on reload. Folding both into the same
 * rebuilt batch — anchored by `afterGroupIndex` (the count of persistable
 * groups when the steer / card arrived) — keeps them at the exact spot they
 * occurred. An end-of-turn card lands where the tool was issued instead of
 * floating above the whole turn.
 *
 * When `inProgress` is true the rows participate in the next delete/reinsert
 * cycle; the final (agent_result) call passes false so the rows are written
 * permanently before `finalizeInProgress`.
 */
export function buildTurnMessages(
  groups: ChatMessageGroup[],
  steered: SteeredMessage[],
  recordedCards: RecordedChatCard[],
  opts: { inProgress: boolean },
): PersistedMessage[] {
  const persistable = groups.filter((g) => g.text || g.toolUse.length > 0);
  const out: PersistedMessage[] = [];
  const flag = opts.inProgress ? { inProgress: true as const } : {};

  const persistedSteer = (s: SteeredMessage): PersistedMessage => ({
    role: "user",
    text: s.text,
    images: s.images,
    files: s.files,
    uploadPaths: s.uploadPaths,
    ...flag,
  });

  const persistedCard = (c: RecordedChatCard): PersistedMessage => ({
    ...c.message,
    ...flag,
  });

  // At a given anchor, emit steered user messages first, then chat cards — so a
  // card recorded after the user's last steer renders below it.
  const emitAnchoredAt = (index: number) => {
    for (const s of steered) {
      if (s.afterGroupIndex === index) out.push(persistedSteer(s));
    }
    for (const c of recordedCards) {
      if (c.afterGroupIndex === index) out.push(persistedCard(c));
    }
  };

  for (let i = 0; i < persistable.length; i++) {
    emitAnchoredAt(i);
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
  // Steers / cards anchored at or beyond the final group count land after
  // everything. The `>=` clamp guards against an anchor that outran the
  // persistable groups (e.g. the anchoring group never produced persistable
  // content). This is the common case for an end-of-turn card.
  for (const s of steered) {
    if (s.afterGroupIndex >= persistable.length) out.push(persistedSteer(s));
  }
  for (const c of recordedCards) {
    if (c.afterGroupIndex >= persistable.length) out.push(persistedCard(c));
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
  attachments?: Pick<SteeredMessage, "images" | "files" | "uploadPaths">,
): void {
  const afterGroupIndex = runner.chatMessageGroups.filter((g) => g.text || g.toolUse.length > 0).length;
  runner.steeredMessages = [
    ...runner.steeredMessages,
    {
      afterGroupIndex,
      text,
      images: attachments?.images,
      files: attachments?.files,
      uploadPaths: attachments?.uploadPaths,
    },
  ];
  // docs/140 diag — capture the steered-message inject point. Pairs with the
  // `[persist-user]` logs to confirm whether the same user text was both
  // appended (via persistUserMessage) and injected into the in-progress batch
  // (via this path) during one user-send — the suspected double-bubble cause.
  console.log(
    `[steered] recordSteeredMessage afterGroupIndex=${afterGroupIndex} steered.len=${runner.steeredMessages.length} text=${JSON.stringify(text.slice(0, 60))}`,
  );
}

/**
 * Persist the current turn's groups + steered messages + recorded cards as the
 * in-progress set. Shared by the steer handler (so a mid-turn injection is saved
 * immediately) and the tool-result boundary in `wireAgentListeners`.
 */
export function persistTurnInProgress(
  chatHistoryManager: { replaceInProgress(sessionId: string, messages: PersistedMessage[]): void },
  runner: { chatMessageGroups: ChatMessageGroup[]; steeredMessages: SteeredMessage[]; recordedCards: RecordedChatCard[] },
  sessionId: string,
): void {
  chatHistoryManager.replaceInProgress(
    sessionId,
    buildTurnMessages(runner.chatMessageGroups, runner.steeredMessages, runner.recordedCards, { inProgress: true }),
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
 * docs/163 — derive an ear-shaped headline from an observed `AskUserQuestion`
 * input. The fallback floor: used only when the agent didn't author a headline
 * via the built-in `voice_note` tool. We voice the topic (the first question's
 * `header`, or its `question` text) but never the options themselves — those
 * stay on screen.
 */
function deriveAskHeadline(input: Record<string, unknown>): string {
  const first: unknown = Array.isArray(input.questions) ? input.questions[0] : undefined;
  const header = typeof (first as { header?: unknown })?.header === "string"
    ? (first as { header: string }).header.trim()
    : "";
  const question = typeof (first as { question?: unknown })?.question === "string"
    ? (first as { question: string }).question.trim()
    : "";
  const topic = header || question;
  return topic
    ? `I've got a question about ${topic} — options are on screen.`
    : "I've got a question for you — options are on screen.";
}

/**
 * docs/163 — derive an ear-shaped headline from an observed `ExitPlanMode`
 * input. Voices the plan's title (first non-empty line, heading markers
 * stripped) but never the plan body.
 */
function derivePlanHeadline(input: Record<string, unknown>): string {
  const plan = typeof input.plan === "string" ? input.plan : "";
  const firstLine = plan
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean) ?? "";
  const title = firstLine.replace(/^#+\s*/, "").slice(0, 80);
  return title
    ? `I've drafted a plan — ${title}. Want to review it?`
    : "I've drafted a plan — want to review it?";
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
 * Per-turn options accepted by `wireAgentListeners`. Anything that varies
 * between callers (WS-typed, system-dispatched, rebase resolution) belongs
 * here; long-lived dependencies (managers, broadcasters) live in
 * `AgentListenerDeps`.
 */
export interface WireListenersOpts {
  isNewSession: boolean;
  persistUserMessage: (sessionId: string) => void;
  fallbackTitle?: string;
  /**
   * Session ID captured at turn start — immune to session switches. The WS
   * paths capture this from `ctx.getActiveAppSessionId()` (URL-derived on the
   * per-session route); system-dispatched and rebase paths pass the runner's
   * sessionId directly. All call sites pass a value; the optional marker is
   * a vestige of an old test-ergonomics affordance and runtime requires it.
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
   * docs/179 — synchronous gate the `auth_required` handler calls BEFORE it
   * kills the agent: returns true when the turn executor will auto-recover this
   * auth failure (a first attempt with a token healer wired). When true, the
   * handler SUPPRESSES the visible re-auth flow (no sign-in card, no OAuth
   * start) and defers to {@link recoverAuth}; calling it also flips the
   * executor's stand-down flag so the `done` teardown lets the recovery own all
   * terminal work. Absent → the handler always surfaces re-auth (legacy flow).
   */
  willRecoverAuth?: () => boolean;
  /**
   * docs/179 — async recovery the handler kicks off after teardown when
   * {@link willRecoverAuth} returned true: heal the OAuth token and re-dispatch
   * the turn once. Resolves true when recovery is handled (re-dispatched), false
   * when the heal failed — in which case the handler surfaces the sign-in card.
   */
  recoverAuth?: () => Promise<boolean>;
  /**
   * True when this turn is being run on a persistent streaming agent
   * (live steering active, docs/140). In streaming mode the CLI can
   * genuinely block on `AskUserQuestion` (the user's answer flows back via
   * `sendUserMessage`/NDJSON on stdin), so the orchestrator must NOT
   * interrupt on the tool — that would tear down the running turn instead
   * of letting the user steer their answer in.
   */
  useStreaming?: boolean;
}

/**
 * Map the CLI's authoritative `init.permissionMode` string back to the ShipIt
 * `appliedPermissionMode` bookkeeping value. The mapping is the inverse of what
 * `ClaudeAdapter.setPermissionMode` / the spawn flags use:
 *   - `"plan"`    → `"plan"`
 *   - `"auto"`    → `"guarded"` (the CLI's classifier-gated mode)
 *   - `"default"` → `undefined` (ShipIt's no-flag "auto")
 * Any other / absent value (adapters that don't surface it, e.g. Codex) returns
 * the `"unrecognized"` sentinel so the caller leaves the bookkeeping untouched
 * — we never want to clobber a known applied mode with a guess.
 */
function cliPermissionModeToApplied(
  cliMode: string | undefined,
): PermissionMode | undefined | "unrecognized" {
  switch (cliMode) {
    case "plan":
      return "plan";
    case "auto":
      return "guarded";
    case "default":
      return undefined;
    default:
      return "unrecognized";
  }
}

/**
 * Wire up common agent event listeners shared across every entry point that
 * runs an agent turn: WS `send_message` / `answer_question`, system-dispatched
 * turns (Fix CI, child sessions, the `/agent/dispatch` HTTP route), and the
 * rebase conflict-resolution driver. All flows share the same message-group
 * accumulator (`runner.chatMessageGroups`) so tool calls + assistant text
 * round-trip through chat history identically regardless of caller.
 *
 * `runner` must be the registry-resolved reference (not a per-connection
 * `getRunner()` result) so the listener survives WS disconnects. `null` is
 * accepted only as a defensive fallback — the listener degrades to a no-op
 * for state mutations when it's null. Callers should resolve via the registry
 * (`resolveRunner` for WS, `host` for system flows) and pass the result here.
 */
export function wireAgentListeners(
  agent: AgentProcess,
  runner: SessionRunnerInterface | null,
  deps: AgentListenerDeps,
  opts: WireListenersOpts,
): void {
  if (!opts.capturedSessionId) {
    // The previous fallback in the agent_init branch called
    // `setActiveAppSessionId(event.sessionId)` — but `event.sessionId` is the
    // Claude CLI's internal session_id (e.g. `agent-init-1`), not an app
    // session UUID. Setting it as the active app session is always wrong.
    // All callers always set capturedSessionId, so reaching this state means
    // the call site is buggy — fail loudly rather than silently mis-routing.
    throw new Error("wireAgentListeners requires opts.capturedSessionId");
  }
  // Capture the model used for this turn — sourced from `agent_init` (what the
  // CLI actually picked) or falls back to the user-selected model. Used on
  // `agent_result` to attach the model to per-turn usage so the dial can
  // re-target context window when the user switches models mid-session.
  let turnModel: string | undefined = deps.getSelectedModel();
  // Helper: emit to all viewers via runner. If runner is unexpectedly null
  // (registry lookup failed before any viewer attached), the message has
  // nowhere good to go — log and drop rather than try a per-connection send,
  // which doesn't exist on every caller anyway.
  const emitToViewers = (msg: WsServerMessage) => {
    if (runner) {
      runner.emitMessage(msg);
    } else {
      console.warn(`[agent-listeners] dropping ${msg.type} — no runner attached`);
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

  // docs/153 Fix 2 — agent_session_id persistence is deferred until we have
  // evidence the CLI produced usable output. agent_init fires *before* the
  // CLI tries to read the conversation jsonl, so persisting `event.sessionId`
  // at init time would overwrite a freshly-recovered id with a doomed
  // fresh-init UUID when `--resume` is about to fail with "No conversation
  // found". Stash the first init's session id here, flush it on the first
  // signal the turn is actually running (agent_assistant, or the canonical
  // agent_result write below), and short-circuit if we see the missing-
  // conversation stderr line.
  let pendingAgentSessionId: string | null = null;
  let agentSessionIdPersisted = false;
  let missingConversationDetected = false;
  const persistAgentSessionIdIfReady = (): void => {
    if (agentSessionIdPersisted) return;
    if (missingConversationDetected) return;
    if (!pendingAgentSessionId) return;
    const turnSessionId = opts.capturedSessionId;
    if (!turnSessionId) return;
    deps.sessionManager.setAgentSessionId(turnSessionId, pendingAgentSessionId);
    agentSessionIdPersisted = true;
  };

  // ---- Suppress auto-resolved AskUserQuestion tool_results ----
  //
  // The Claude CLI auto-resolves AskUserQuestion in both `-p` headless mode AND
  // `--input-format stream-json` (live steering) — see docs/140 and the
  // AskUserQuestion comment in the agent_assistant branch below. The orchestrator
  // interrupts on seeing the tool_use, but the interrupt is asynchronous (PTY
  // Ctrl+C or a streaming `control_request`), so the auto-resolved tool_result
  // can still reach the orchestrator before the turn ends.
  //
  // If that synthetic tool_result is forwarded to the client and attached to the
  // chat-history message group, the AskUserQuestion card renders as "answered":
  // `MessageList` sets `questionDisabled = !!el.result`, and `AskUserQuestion`
  // derives `submittedAnswers` from the auto-resolved content — graying out the
  // options and rendering the synthetic string as an Other answer. The user can
  // no longer click anything to actually answer.
  //
  // Track the well-formed AskUserQuestion tool_use_ids we interrupt and drop any
  // subsequent tool_result blocks that match them, both from the broadcast event
  // and from the persisted message group. The same set also tracks ExitPlanMode
  // ids under live steering — the streaming CLI auto-resolves that tool the same
  // way, which would otherwise flip the PlanApproval card to "Plan resolved" and
  // strip its Accept/Suggest buttons before the user could act (see the
  // ExitPlanMode block in the agent_assistant branch below).
  const suppressedToolResultIds = new Set<string>();

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
    deps.broadcastLog(source as "stderr" | "stdout" | "server", text);
    // docs/153 Fix 2 — when the Claude CLI's stderr reports a missing
    // conversation for the `--resume <id>` we passed, the fresh init UUID
    // the CLI emits immediately afterwards is doomed: the process exits 1
    // with no usable output. Flip into "do not persist" state so the
    // listener stops the pending agent_session_id from clobbering the DB,
    // and surface a chat-level error so the user sees why the turn aborted
    // (vs. the previous silent loop).
    if (source === "stderr" && /No conversation found with session ID/i.test(text)) {
      if (!missingConversationDetected) {
        missingConversationDetected = true;
        pendingAgentSessionId = null;
        emitToViewers({
          type: "error",
          message: "Couldn't resume the previous conversation — it appears to have been moved or removed. Send your next message to start a fresh thread.",
        });
      }
    }
  });

  agent.on("event", (rawEvent: AgentEvent) => {
    let event = rawEvent;
    // Subscription rate-limits are account-wide telemetry, not chat content:
    // route them into the limits badge (which broadcasts its own SSE) and
    // stop — forwarding as an `agent_event` would just be noise for the chat
    // message grouping. Both Claude (via the CLI's `rate_limit_event` stream
    // messages) and Codex (via `account/rateLimits/updated`) feed this same
    // single callback — the orchestrator dispatches to the right provider.
    // See docs/135.
    if (event.type === "agent_rate_limits") {
      deps.recordAgentRateLimits?.(agent.agentId, event.session, event.weekly);
      return;
    }

    // docs/140 — a live steer the backend refused (Codex rejects `turn/steer`
    // during review / manual-compaction turns with `ActiveTurnNotSteerable`).
    // The message was already optimistically rendered + recorded as an
    // in-progress steered row; rather than let it vanish, drop that row and
    // re-queue the text so it runs as the next turn. Steerability is a
    // turn-level property (a non-steerable turn rejects EVERY steer for its
    // whole duration, and a steerable one accepts them all), so popping the
    // OLDEST pending steer per rejection both preserves send order and can't
    // re-queue a steer that actually landed. This is NOT chat content — handle
    // it and return before the message accumulator, exactly like rate-limits.
    if (event.type === "agent_steer_rejected") {
      const turnSessionId = opts.capturedSessionId;
      if (runner) {
        const pending = runner.steeredMessages;
        // Pop the oldest pending steer (FIFO). Its stored `text` is the raw
        // user message (not the assembled prompt the adapter echoes back), so
        // the re-queued bubble matches what the user typed.
        const dropped = pending[0];
        if (dropped) {
          runner.steeredMessages = pending.slice(1);
          // Re-persist the in-progress set without the dropped steer so a
          // reload doesn't show it twice (once here, once when the queued turn
          // runs and persists its own user row).
          if (turnSessionId) {
            persistTurnInProgress(deps.chatHistoryManager, runner, turnSessionId);
          }
        }
        // Re-queue the original text (+ best-effort attachments). The post-turn
        // drain feeds it as the next turn once the current (non-steerable) turn
        // ends. Fall back to the adapter-echoed text if there's no record.
        const requeueText = dropped?.text ?? event.text;
        const queued: QueuedMessage = { text: requeueText };
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

    // docs/178 — context compaction in flight. Transient progress only: forward
    // an emit-only "Compacting…" indicator and stop before the message
    // accumulator (it has no place in the scrollback). Like rate-limits and
    // steer-rejected, this is not chat content. Both CLIs may compact
    // unsolicited mid-turn, so this can arrive with no user `/compact`.
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

    // docs/178 — compaction finished. This IS transcript content (the history
    // was replaced by a summary), so persist a card via `emitChatCard` (the one
    // supported way to add a transcript card off the agent-event stream — it
    // both emits live AND records in-band with the turn so it survives a
    // reconnect, a session switch, and a full reload). Also clears the transient
    // indicator. Return before the accumulator — the card is the record.
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
        );
      }
      return;
    }

    if (event.type === "agent_result" && event.error) {
      event = {
        ...event,
        error: normalizeAgentUsageLimitError(
          agent.agentId,
          event.error,
          deps.getSubscriptionLimitsSnapshot?.(),
        ),
      };
    }

    // Drop auto-resolved tool_result blocks for AskUserQuestion calls we
    // interrupted. See `suppressedToolResultIds` declaration for why. If
    // filtering removes every block, skip the whole event — the client has
    // nothing to render and per-type handling below would no-op on empty
    // content anyway.
    if (event.type === "agent_tool_result" && suppressedToolResultIds.size > 0) {
      const content = (event as { content?: unknown[] }).content ?? [];
      const filtered = content.filter((b) => {
        if (typeof b !== "object" || b === null) return true;
        const id = (b as Record<string, unknown>).tool_use_id;
        return typeof id !== "string" || !suppressedToolResultIds.has(id);
      });
      if (filtered.length === 0) return;
      if (filtered.length !== content.length) {
        event = { ...event, content: filtered } as AgentEvent;
      }
    }

    const isInternalStreamCompletion =
      event.type === "agent_assistant" && event.isStreamCompletion;
    if (!isInternalStreamCompletion) {
      emitToViewers({ type: "agent_event", event });
    }

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
      // docs/178 — the Claude CLI emits a SECOND `system/init` mid-stream after
      // it compacts context (and subagents each emit their own init). Only the
      // FIRST init per wired-agent is the real process start / the turn's
      // session+permission baseline; the guarded-mode availability check below
      // is gated on this so a post-compaction re-init can't flip
      // `guardedUnavailable` or re-emit a spurious downgrade notice. `pendingAgentSessionId`
      // already resists overwrite via `??=`, so the resume key is safe too.
      const isFirstInit = !hasLoggedAgentStart;
      if (!hasLoggedAgentStart) {
        hasLoggedAgentStart = true;
        deps.broadcastLog("server", "Agent process started");
      }
      // docs/153 Fix 2 — stash the init's sessionId; persist it lazily on
      // the first agent_assistant or agent_result so a `--resume` failure
      // (which always emits a *fresh* init UUID right before exiting) can't
      // overwrite the recovered id or a healthy session's prior id. Only the
      // top-level turn's first init is recorded — subagent inits emit their
      // own sessionIds which are not the resume key for the next turn.
      pendingAgentSessionId ??= event.sessionId;
      const session = deps.sessionManager.get(turnSessionId);
      if (session) {
        emitToViewers({ type: "session_started", session });
        deps.sseBroadcast("session_started", { session });
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
      if (opts.requestedPermissionMode === "guarded" && runner && isFirstInit) {
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

      // Plan-mode desync fix — resync `appliedPermissionMode` from the CLI's
      // authoritative `init.permissionMode`. A persistent streaming CLI keeps
      // its spawn-time `--permission-mode` for life, but the orchestrator's
      // `appliedPermissionMode` bookkeeping can drift (it's cleared on
      // `setAgent(null)` during proxy recreation on reload, and the client chip
      // falls back to "auto" after a reload). When it drifts to `undefined`
      // while the CLI is still pinned to `plan`, the between-turns mode-change
      // gate (send-message / turn-executor) compares "auto requested" against
      // "auto applied", skips the freeing `set_permission_mode` push, and the
      // session is permanently wedged ("can't exit plan mode"). The init event
      // is the CLI's own report of its current mode, so trust it over local
      // bookkeeping. Only act on a recognized CLI mode — adapters that don't
      // surface it (Codex) leave the bookkeeping untouched. Not gated on
      // `isFirstInit`: a post-compaction / post-`set_permission_mode` re-init
      // also carries the real mode, and resyncing from it is always safe.
      if (runner) {
        const synced = cliPermissionModeToApplied(event.permissionMode);
        if (synced !== "unrecognized") {
          runner.appliedPermissionMode = synced;
        }
      }
    }

    if (event.type === "agent_assistant") {
      // docs/153 Fix 2 — the CLI has produced an assistant content block,
      // so the resumed (or freshly-init'd) session is real. Persist the
      // top-level init's sessionId to the DB now. agent_result's persist
      // below is the authoritative final write; this earlier persist
      // guards the case where the process exits abnormally between first
      // assistant and result (network drop, OOM, etc.) — without it the
      // next turn's --resume would lose the rotation.
      persistAgentSessionIdIfReady();

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

      // Stream completion (Codex deltas finished): replace turnSummary with
      // the FULL text, but skip accumulator/chat-group updates — the deltas
      // already populated those. Without this, turnSummary would be the last
      // tiny delta (often "."), which became the commit message.
      if (event.isStreamCompletion) {
        if (text && runner) runner.turnSummary = text;
        return;
      }

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

      // docs/163 — source observation for the voice-note router. A top-level
      // AskUserQuestion / ExitPlanMode interrupt always needs the user, so it
      // should reach a hands-free user as a spoken headline. Authored-first:
      // if the agent already authored a headline via the built-in `voice_note`
      // tool this turn, ShipIt uses that and suppresses this derived nudge.
      // Derivation is the fallback floor only — never leave the user silent.
      // (Gated on the authored flag, which the bridge route sets synchronously;
      // the per-turn cap in the router backstops any rare same-message overlap.)
      if (runner && deps.deliverVoiceNote && !hasAuthoredVoiceNoteThisTurn(runner)) {
        const ask = toolBlocks.find(isWellFormedAskUserQuestion);
        const plan = toolBlocks.find((t) => t.name === "ExitPlanMode");
        if (ask) {
          deps.deliverVoiceNote(
            { summary: deriveAskHeadline(ask.input), needsAttention: true },
            runner,
            "ask",
          );
        } else if (plan) {
          deps.deliverVoiceNote(
            { summary: derivePlanHeadline(plan.input), needsAttention: true },
            runner,
            "plan",
          );
        }
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
      // docs/140 — live steering: the original assumption was that the CLI in
      // `--input-format stream-json` mode would genuinely block awaiting the
      // user's answer. In practice it auto-resolves the tool call the same way
      // headless `-p` mode does, so the model moved on before the user could
      // pick an answer. Interrupt in both modes. In streaming mode `interrupt()`
      // is a `control_request` that ends the turn with `error_during_execution`
      // while keeping the persistent process alive, so the answer can still
      // flow back via `sendUserMessage`/NDJSON in `handleAnswerQuestion`.
      if (runner && toolBlocks.some(isWellFormedAskUserQuestion)) {
        runner.wasInterrupted = true;
        // Remember the AskUserQuestion ids so we can drop the CLI's
        // auto-resolved tool_result for them — otherwise the client renders the
        // card as already-answered and the user can't click any option.
        for (const t of toolBlocks) {
          if (isWellFormedAskUserQuestion(t)) suppressedToolResultIds.add(t.id);
        }
        agent.interrupt();
        deps.broadcastLog("server", "Agent interrupted: waiting for AskUserQuestion answer");
      }

      // ExitPlanMode blocking (live steering only). In the one-shot `-p
      // --permission-mode plan` path the CLI ends the turn at ExitPlanMode (the
      // model has presented its plan and the headless process exits), so the
      // PlanApproval card renders with its Accept/Suggest buttons intact and
      // there is nothing to fix. The persistent streaming process behaves
      // differently: ExitPlanMode auto-resolves the same way AskUserQuestion
      // does (the CLI emits an `is_error` tool_result because there's no human
      // to approve the plan exit) and the model charges ahead in the SAME turn
      // — still in plan mode, so its Write/Edit/Bash calls are blocked and it
      // complains it "can't exit plan mode." Meanwhile the auto-resolved
      // tool_result flips the PlanApproval card to "Plan resolved" and disables
      // the buttons, so the user can never click "Accept & Execute" (which is
      // what actually switches the session out of plan mode).
      //
      // Fix: mirror the AskUserQuestion treatment under streaming. Interrupt so
      // the model stops at the plan boundary, and suppress the auto-resolved
      // tool_result so the card stays interactive. The user then clicks
      // "Accept & Execute" (switches the session to auto + sends a fresh
      // "Execute the plan" message) or "Suggest Changes" — both fresh turns,
      // consistent with every other turn boundary.
      if (opts.useStreaming && runner && toolBlocks.some((t) => t.name === "ExitPlanMode")) {
        runner.wasInterrupted = true;
        for (const t of toolBlocks) {
          if (t.name === "ExitPlanMode") suppressedToolResultIds.add(t.id);
        }
        agent.interrupt();
        deps.broadcastLog("server", "Agent interrupted: waiting for plan approval");
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
          runner?.recordedCards ?? [],
          { inProgress: true },
        );
        deps.chatHistoryManager.replaceInProgress(usageSessionId, inProgressMessages);
        if (runner) runner.lastPersistedBufferIndex = runner.getTurnEventBuffer().length;
      }
    }

    if (event.type === "agent_result") {
      const turnSessionId = opts.capturedSessionId;
      if (turnSessionId) {
        // docs/153 Fix 2 — only write the result's sessionId when the turn
        // actually produced something. A `--resume <missing-id>` turn emits
        // both agent_init AND agent_result with fresh, useless UUIDs before
        // exiting; the stderr scan above sets `missingConversationDetected`
        // which we honor here. agentSessionIdPersisted is also `true` after
        // the first assistant for healthy turns, so this stays the canonical
        // rotation write for those.
        if (!missingConversationDetected) {
          deps.sessionManager.setAgentSessionId(turnSessionId, event.sessionId);
          agentSessionIdPersisted = true;
        }
        deps.sessionManager.track(turnSessionId);
        deps.sseBroadcast("session_list", { sessions: deps.sessionManager.list() });
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
        deps.usageManager.record(
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
        const sessionUsage = deps.usageManager.getSessionUsage(usageSessionId);
        if (sessionUsage) {
          const tokenTotals = deps.usageManager.getSessionTokenTotals(usageSessionId);
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
        runner?.recordedCards ?? [],
        { inProgress: false },
      );
      deps.chatHistoryManager.replaceInProgress(usageSessionId, finalMessages);
      deps.chatHistoryManager.finalizeInProgress(usageSessionId);
      if (runner) runner.lastPersistedBufferIndex = runner.getTurnEventBuffer().length;

      // If `postTurnCommit` ran earlier in this turn (e.g. the codex CLI's
      // first `turn/completed` arrived BEFORE the final assistant text events)
      // but couldn't link the commit because there were no in_progress=0 rows
      // yet, the link info was stashed on the runner. Apply it now that the
      // rows actually exist. This is the second half of the fix described in
      // `postTurnCommit` (see `opts.runner` there).
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

      // docs/182 — record the turn's terminal error state definitively at
      // completion (true when this result carries an error that wasn't a
      // deliberate interrupt; false on a clean finish). Mirrored to the session
      // row so it survives an orchestrator restart, and read by the
      // child-session readiness check so `shipit session wait` resolves a
      // distinct `error` outcome instead of a false `idle`. Writing on every
      // completion means a child that errored then succeeded on a follow-up turn
      // clears the flag without a separate reset.
      const turnErrored = Boolean((event as { error?: unknown }).error) && !runner?.wasInterrupted;
      if (runner) runner.lastTurnErrored = turnErrored;
      if (turnSessionId) deps.sessionManager.setLastTurnErrored(turnSessionId, turnErrored);

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
    const turnSession = opts.capturedSessionId
      ? deps.sessionManager.get(opts.capturedSessionId)
      : null;
    const failingAgentId = turnSession?.agentId;
    const turnSessionId = opts.capturedSessionId;

    // docs/179 — decide SYNCHRONOUSLY (before the teardown below kills the agent
    // and triggers the executor's `done` handler) whether this auth failure
    // will be auto-recovered. `willRecoverAuth` returns true only for a first-
    // attempt turn with a token healer wired, and flips the executor's stand-
    // down flag so the `done` teardown defers to the recovery. When true we
    // stay quiet — no sign-in card, no OAuth flow — and let `recoverAuth` heal
    // the token and re-dispatch the turn. A transient stale-token 401 thus
    // recovers without the user seeing anything or re-sending.
    const willRecover = opts.willRecoverAuth?.() ?? false;

    // The visible re-auth flow: flip the sign-in card, start the failing
    // backend's OAuth flow, nudge the per-agent hook, and mark the turn ended.
    const surfaceReauth = (): void => {
      console.log("[server] Agent CLI requires authentication, starting OAuth flow");
      emitToViewers({ type: "auth_required" });
      // docs/155 Phase 2c — start the auth manager for the failing turn's
      // backend (not always Claude OAuth). Fallback to `authManager` keeps
      // legacy test contexts (which don't construct `authManagers`) working.
      const mgr = failingAgentId ? deps.authManagers?.get(failingAgentId) : undefined;
      if (mgr) {
        mgr.start();
      } else {
        deps.authManager.startOAuthFlow();
      }
      // docs/153, docs/155 — let the per-agent module decide its side effect on
      // auth failure (Claude nudges the OAuth refresher; others register their
      // own hook or none). The listener doesn't know the agent — that's the
      // point of the table.
      if (failingAgentId) {
        deps.onAgentAuthRequired?.(failingAgentId);
      }
      if (runner && turnSessionId) {
        emitToViewers({
          type: "session_status",
          sessionId: turnSessionId,
          running: false,
          queueLength: runner.queueLength,
        });
      }
      if (turnSessionId) {
        deps.sseBroadcast("session_agent_finished", { sessionId: turnSessionId });
      }
    };

    // Tear the failed turn's agent down. An auth failure ends the turn, but a
    // persistent streaming agent (live steering) does NOT exit on a failed
    // result, so the worker never clears `this.agent` and the runner is left
    // with `running=true` — the next turn then 409s with "Agent already
    // running". Killing the worker agent + clearing the runner's ref makes the
    // failure recoverable. See docs/142 (Problem B1). Kill is fire-and-forget;
    // the proxy surfaces any failure via the Logs panel, not the chat.
    agent.kill();
    if (runner) {
      // Identity-guard: a concurrent turn may have replaced the runner's
      // agent ref already; only clear if it's still our process.
      if (runner.getAgent() === agent) {
        runner.setAgent(null);
        // docs/140 — streaming process is gone; reset the gate.
        runner.isStreamingActive = false;
      }
      // docs/179 — on the recovery path leave `running` set: the turn is about
      // to be re-dispatched, so flipping it (and emitting running=false) would
      // make the client flicker out of its loading state. The re-dispatch
      // resets turn state. On the surface path, the teardown below clears it.
      if (!willRecover) runner.running = false;
    }

    if (willRecover && opts.recoverAuth) {
      // docs/179 — quiet path: heal + re-dispatch. If the heal genuinely fails
      // (token revoked / rate-limited), fall back to the visible re-auth flow.
      // Fire-and-forget: `auth_required` is a sync event handler.
      // eslint-disable-next-line no-restricted-syntax -- intentional fire-and-forget in a sync event handler
      void opts.recoverAuth().then(
        (handled) => {
          if (!handled) surfaceReauth();
        },
        (err: unknown) => {
          // recoverAuth owns its own errors and resolves false on a failed heal;
          // a rejection here is unexpected. Fail open — surface the sign-in card
          // rather than leaving the turn wedged behind an unhandled rejection.
          console.error("[server] docs/179 auth recovery rejected unexpectedly:", err);
          surfaceReauth();
        },
      );
      return;
    }
    surfaceReauth();
  });

  agent.on("error", async (err: Error) => {
    console.error("[agent] process error:", err.message);
    deps.broadcastLog("server", `Agent process error: ${err.message}`);
    emitToViewers({ type: "error", message: `Agent process error: ${err.message}` });
    const turnSessionId = opts.capturedSessionId;
    if (turnSessionId) {
      // Preserve whatever partial turn the agent produced before it errored.
      // Mirrors the agent_result path: persist the accumulated message groups
      // and finalize them, *then* append the error message. The old code
      // called clearInProgress() here, which deleted the entire in-progress
      // turn — so a crash mid-turn wiped all of the agent's work from the UI
      // on the next history load.
      // Pass empty steers (this path historically drops them) but keep recorded
      // cards so a voice note / bug-report card recorded before the crash isn't
      // lost on reload — the card is folded in at its true position, same as a
      // clean finalize.
      const partialMessages = buildTurnMessages(
        runner?.chatMessageGroups ?? [],
        [],
        runner?.recordedCards ?? [],
        { inProgress: false },
      );
      deps.chatHistoryManager.replaceInProgress(turnSessionId, partialMessages);
      deps.chatHistoryManager.finalizeInProgress(turnSessionId);
      deps.chatHistoryManager.append(turnSessionId, {
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
      // Identity-guard: only clear the runner's agent ref if it still points
      // at us. A later turn may already have replaced it; clobbering to null
      // would silently drop every subsequent SSE event from that turn.
      if (runner.getAgent() === agent) {
        runner.setAgent(null);
        // docs/140 — streaming process is gone; reset the gate.
        runner.isStreamingActive = false;
      }
      runner.running = false;
      // docs/182 — a process-level error is a terminal turn error: record it on
      // the runner and persist it so `shipit session wait` reports `error`
      // (exit 3) even after an orchestrator restart loses the in-memory flag.
      runner.lastTurnErrored = true;
      if (turnSessionId) deps.sessionManager.setLastTurnErrored(turnSessionId, true);
      // docs/163 — the errored turn has just been finalized into chat history
      // (replaceInProgress + finalize + the error row above). Clear the
      // turn-event replay buffer so a subsequent WS reconnect doesn't re-emit
      // those same events on top of the already-persisted turn. Without this,
      // the buffer stays dirty (lastPersistedBufferIndex only advances on
      // tool-result / agent_result boundaries, never on the error path), and
      // every reconnect — including a browser reload — replays the completed
      // turn a second time, producing a duplicate that survives reload. This
      // mirrors the clean-completion path in the `agent_result` handler.
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
      runner.onAgentFinished();
    }
    if (turnSessionId) {
      deps.sseBroadcast("session_agent_finished", { sessionId: turnSessionId });
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
