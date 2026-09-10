import type { AgentEvent, ClaudeContentBlockToolUse, PermissionMode, WsServerMessage } from "../../shared/types.js";
import type { ToolResultEntry } from "../session-runner.js";

// Adapters can pass bare string content despite the declared array type.
export function extractToolResults(event: AgentEvent): ToolResultEntry[] {
  const raw = (event as { content?: unknown }).content;
  const content: unknown[] = Array.isArray(raw) ? raw : [];
  return content
    .filter((b): b is Record<string, unknown> =>
      typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "tool_result" && !!(b as Record<string, unknown>).tool_use_id)
    .map((b) => ({
      toolUseId: b.tool_use_id as string,
      content: typeof b.content === "string" ? b.content
        : (b.content === null || b.content === undefined) ? ""
        : JSON.stringify(b.content),
      isError: (b.is_error as boolean) ?? false,
      ...(typeof b.duration_ms === "number" ? { durationMs: b.duration_ms } : {}),
    }));
}

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

export const MCP_TOOL_NAME_RE = /^mcp__([a-z][a-z0-9]*)__/;

// Let malformed calls reach CLI validation instead of interrupting the turn.
export function isWellFormedAskUserQuestion(t: ClaudeContentBlockToolUse): boolean {
  if (t.name !== "AskUserQuestion") return false;
  const questions = (t.input as { questions?: unknown }).questions;
  return Array.isArray(questions) && questions.length > 0;
}

export function summarizeCrashReason(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return "tool call failed";
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? trimmed;
  const MAX = 240;
  return firstLine.length > MAX ? `${firstLine.slice(0, MAX - 1)}…` : firstLine;
}

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

export interface AgentToolTracker {
  recordToolUses(blocks: readonly { id: string; name: string }[]): void;
  reportMcpCrashesFromResults(results: ToolResultEntry[]): void;
  getToolName(id: string): string | undefined;
  readonly toolUseStartTimes: Map<string, number>;
}

export function createAgentToolTracker(
  sessionId: string,
  emit: (msg: WsServerMessage) => void,
): AgentToolTracker {
  const toolUseIdToName = new Map<string, string>();
  const crashedServersThisTurn = new Set<string>();
  const toolUseStartTimes = new Map<string, number>();

  const recordToolUses = (blocks: readonly { id: string; name: string }[]): void => {
    const seenAt = Date.now();
    for (const block of blocks) {
      toolUseIdToName.set(block.id, block.name);
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

  const getToolName = (id: string): string | undefined => toolUseIdToName.get(id);

  return { recordToolUses, reportMcpCrashesFromResults, getToolName, toolUseStartTimes };
}
