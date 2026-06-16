// Tool-name helpers shared by the chat renderers (visual-elements grouping and
// message-tools rendering). Kept in their own module so the pure grouping layer
// (`visual-elements.ts`) doesn't have to import the React component file.

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
