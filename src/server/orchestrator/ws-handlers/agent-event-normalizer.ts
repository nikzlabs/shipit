import type { AgentEvent, ClaudeContentBlockToolUse, PermissionMode, WsServerMessage } from "../../shared/types.js";
import type { ToolResultEntry } from "../session-runner.js";

/**
 * Pure event-normalization helpers shared by `wireAgentListeners`: translating
 * raw agent NDJSON into ShipIt domain shapes (tool-result extraction, per-tool
 * timing), permission-mode translation, AskUserQuestion well-formedness, and
 * MCP mid-turn crash attribution (docs/088). Extracted from
 * `agent-listeners.ts` as part of the Phase P6 split (docs/201). No behavior
 * change — every function keeps its original semantics; the listener imports
 * them back.
 */

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
      // Per-tool duration injected by `stampToolDurations` before the event is
      // emitted/persisted. Reading it here is what carries timing into the
      // persisted `toolResults` JSON (chat-history) with no extra plumbing.
      ...(typeof b.duration_ms === "number" ? { durationMs: b.duration_ms } : {}),
    }));
}

/**
 * Inject a derived `duration_ms` onto each `tool_result` content block of an
 * agent_tool_result event, computed as `now - startTime` for the matching
 * tool_use id. The CLI gives us no per-tool timing, so we time it ourselves at
 * the parse boundary: tool_use starts are stamped when the block is observed
 * (see `toolUseStartTimes` in `createAgentToolTracker`), and this stamps the
 * result when it arrives. Mutating the event content (rather than a side
 * channel) means the single value rides BOTH paths — the live WS event the
 * client reads and the persisted `toolResults` that `extractToolResults` builds
 * — from one source. Returns the event unchanged (same reference) when nothing
 * was stamped, so non-tool-result events and results without a recorded start
 * are zero-cost.
 */
export function stampToolDurations(
  event: AgentEvent,
  startTimes: Map<string, number>,
  now: number,
): AgentEvent {
  const content = (event as { content?: unknown[] }).content;
  if (!Array.isArray(content)) return event;
  let changed = false;
  const stamped = content.map((b) => {
    if (typeof b !== "object" || b === null) return b;
    const block = b as Record<string, unknown>;
    if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") return b;
    if (typeof block.duration_ms === "number") return b;
    const start = startTimes.get(block.tool_use_id);
    if (start === undefined) return b;
    changed = true;
    return { ...block, duration_ms: Math.max(0, now - start) };
  });
  return changed ? ({ ...event, content: stamped } as AgentEvent) : event;
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
export const MCP_TOOL_NAME_RE = /^mcp__([a-z][a-z0-9]*)__/;

/**
 * True when an AskUserQuestion tool_use carries a non-empty `questions` array.
 * Used to gate the "interrupt the CLI so it can't auto-resolve the call"
 * behavior: an input without `questions` is rejected by the CLI's own input
 * validator (InputValidationError flows back as a tool_result), and the client
 * can't render the card without it either — so interrupting on a malformed
 * call would just kill the turn before the model can self-correct.
 */
export function isWellFormedAskUserQuestion(t: ClaudeContentBlockToolUse): boolean {
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
export function summarizeCrashReason(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return "tool call failed";
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? trimmed;
  const MAX = 240;
  return firstLine.length > MAX ? `${firstLine.slice(0, MAX - 1)}…` : firstLine;
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
export function cliPermissionModeToApplied(
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
 * Per-turn tool tracker: records `id → name` and a start timestamp for every
 * tool_use observed this turn, and attributes `is_error` tool results back to
 * the MCP server that produced them (docs/088 mid-turn crash detection).
 *
 * `toolUseStartTimes` is exposed so `stampToolDurations` can read the recorded
 * starts. State is per-wired-agent (one tracker per turn) so the dedupe set and
 * timing map reset naturally between turns.
 */
export interface AgentToolTracker {
  /**
   * Record `id → name` for every tool_use (including subagent ones — Task
   * children dispatch MCP tools too) and stamp a first-observation start time.
   */
  recordToolUses(blocks: readonly { id: string; name: string }[]): void;
  /**
   * Scan tool results for `is_error` failures attributable to a configured MCP
   * server, dedupe per-turn-per-server, and emit `mcp_server_status` with
   * `state: "crashed"`.
   */
  reportMcpCrashesFromResults(results: ToolResultEntry[]): void;
  /** Per-tool start timestamps, consumed by `stampToolDurations`. */
  readonly toolUseStartTimes: Map<string, number>;
}

/**
 * Create a per-turn {@link AgentToolTracker}. `sessionId` is the turn's
 * captured session id (fixed for the turn); `emit` broadcasts to viewers via
 * the runner. McpStore.applyStatus is last-write-wins, so the next successful
 * init event from a future turn naturally clears the badge back to `loaded`.
 */
export function createAgentToolTracker(
  sessionId: string,
  emit: (msg: WsServerMessage) => void,
): AgentToolTracker {
  const toolUseIdToName = new Map<string, string>();
  const crashedServersThisTurn = new Set<string>();
  // Per-tool timing (docs/185): the CLI emits no per-tool duration, only a
  // turn-level one. We derive it by stamping a start when each tool_use block is
  // observed and computing the delta when its tool_result arrives
  // (`stampToolDurations`). Surfaced in the tool-call detail modal.
  const toolUseStartTimes = new Map<string, number>();

  const recordToolUses = (blocks: readonly { id: string; name: string }[]): void => {
    const seenAt = Date.now();
    for (const block of blocks) {
      toolUseIdToName.set(block.id, block.name);
      // First observation wins — never overwrite a start with a later re-record.
      if (!toolUseStartTimes.has(block.id)) toolUseStartTimes.set(block.id, seenAt);
    }
  };

  const reportMcpCrashesFromResults = (results: ToolResultEntry[]): void => {
    for (const result of results) {
      if (!result.isError) continue;
      const toolName = toolUseIdToName.get(result.toolUseId);
      if (!toolName) continue;
      const match = MCP_TOOL_NAME_RE.exec(toolName);
      if (!match) continue;
      const serverName = match[1];
      if (crashedServersThisTurn.has(serverName)) continue;
      crashedServersThisTurn.add(serverName);
      emit({
        type: "mcp_server_status",
        sessionId,
        name: serverName,
        state: "crashed",
        reason: summarizeCrashReason(result.content),
      });
    }
  };

  return { recordToolUses, reportMcpCrashesFromResults, toolUseStartTimes };
}
