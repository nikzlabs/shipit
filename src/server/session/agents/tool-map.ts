/**
 * Canonical tool name mapping — normalizes agent-specific tool names into
 * a shared vocabulary so the client can render tool activity labels and
 * diff views without knowing which CLI is running.
 *
 * The per-agent slices live under `./<agentId>/tool-map.ts`. Adding a new
 * backend is one new slice + one entry in `AGENT_TOOL_MAPS`. See docs/155.
 */

import type { AgentId } from "./agent-process.js";
import { CLAUDE_TOOL_MAP } from "./claude/tool-map.js";
import { CODEX_TOOL_MAP } from "./codex/tool-map.js";

export type CanonicalTool =
  | "file_read"
  | "file_write"
  | "file_edit"
  | "shell"
  | "glob"
  | "grep"
  | "web_fetch"
  | "web_search"
  | "ask_user"
  | "browser";

const AGENT_TOOL_MAPS: Record<AgentId, Record<string, CanonicalTool>> = {
  claude: CLAUDE_TOOL_MAP,
  codex: CODEX_TOOL_MAP,
};

/**
 * Map an agent-specific tool name to its canonical equivalent.
 * Returns null if the tool name is not recognized for the given agent.
 */
export function canonicalizeTool(
  agentId: AgentId,
  toolName: string,
): CanonicalTool | null {
  return AGENT_TOOL_MAPS[agentId]?.[toolName] ?? null;
}

/**
 * Reverse lookup: get the agent-specific tool name from a canonical name.
 * Returns null if no mapping exists for the given agent.
 */
export function agentToolName(
  agentId: AgentId,
  canonical: CanonicalTool,
): string | null {
  const map = AGENT_TOOL_MAPS[agentId];
  if (!map) return null;
  for (const [agentName, canon] of Object.entries(map)) {
    if (canon === canonical) return agentName;
  }
  return null;
}
