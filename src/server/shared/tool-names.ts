export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const parts = name.split("__");
  if (parts.length < 3) return null;
  return { server: parts[1], tool: parts.slice(2).join("__") };
}

export function isPresentTool(name: string): boolean {
  if (name === "present") return true;
  const parsed = parseMcpToolName(name);
  if (parsed?.tool !== "present") return false;
  return parsed.server === "shipit" || parsed.server === "shipit-present";
}
