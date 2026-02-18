/**
 * Canonical tool name mapping — normalizes agent-specific tool names into
 * a shared vocabulary so the client can render tool activity labels and
 * diff views without knowing which CLI is running.
 */

import type { AgentId } from "./agent-process.js";

export type CanonicalTool =
  | "file_read"
  | "file_write"
  | "file_edit"
  | "shell"
  | "glob"
  | "grep"
  | "web_fetch"
  | "web_search"
  | "ask_user";

const CLAUDE_TOOL_MAP: Record<string, CanonicalTool> = {
  Read: "file_read",
  Write: "file_write",
  Edit: "file_edit",
  Bash: "shell",
  Glob: "glob",
  Grep: "grep",
  WebFetch: "web_fetch",
  WebSearch: "web_search",
  AskUserQuestion: "ask_user",
};

const CODEX_TOOL_MAP: Record<string, CanonicalTool> = {
  shell: "shell",
  file_write: "file_write",
  file_read: "file_read",
};

const GEMINI_TOOL_MAP: Record<string, CanonicalTool> = {
  // Placeholder — will be populated once Gemini CLI tool names are confirmed
};

const AGENT_TOOL_MAPS: Record<AgentId, Record<string, CanonicalTool>> = {
  claude: CLAUDE_TOOL_MAP,
  codex: CODEX_TOOL_MAP,
  gemini: GEMINI_TOOL_MAP,
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
