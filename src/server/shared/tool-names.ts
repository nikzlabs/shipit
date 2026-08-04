/**
 * Tool-name helpers shared by the chat renderers and the orchestrator's
 * docs/244 wire projection.
 *
 * These live in shared code because the projection has to answer the same
 * question the renderer does — "does anything draw this tool's result content?"
 * — and a drift between the two answers is a silent bug in either direction: a
 * body stripped from the wire that something renders shows up blank, and a body
 * kept for a renderer that doesn't exist ships bytes nobody sees.
 */

/** Parses an MCP tool name like "mcp__playwright__browser_take_screenshot" into { server, tool } parts. */
export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const parts = name.split("__");
  if (parts.length < 3) return null;
  return { server: parts[1], tool: parts.slice(2).join("__") };
}

/**
 * True for the ShipIt `present` tool in any of its emitted name forms: the bare
 * `present`, the consolidated `mcp__shipit__present` (SHI-128), and the legacy
 * per-tool `mcp__shipit-present__present` (so already-persisted present cards in
 * pre-SHI-128 sessions, whose tool names are stored verbatim, still match).
 */
export function isPresentTool(name: string): boolean {
  if (name === "present") return true;
  const parsed = parseMcpToolName(name);
  if (parsed?.tool !== "present") return false;
  return parsed.server === "shipit" || parsed.server === "shipit-present";
}
