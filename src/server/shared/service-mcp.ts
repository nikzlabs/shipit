/**
 * docs/327-service-mcp-servers — the declaration form a plugin manifest and a
 * project's shipit.yaml share. Shared with the browser; keep filesystem imports out.
 */

export const DEFAULT_SERVICE_MCP_PATH = "/mcp";

// Codex writes the name into a TOML table key, so a dot would split it.
const MCP_SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MCP_PATH_RE = /^\/[A-Za-z0-9._~/-]*$/;

/** Servers every agent already has. */
export const RESERVED_MCP_SERVER_NAMES: ReadonlySet<string> = new Set(["shipit", "playwright"]);

/** Null when usable; otherwise the reason, phrased to follow "it". */
export function mcpServerNameError(name: string): string | null {
  if (!MCP_SERVER_NAME_RE.test(name)) {
    return "must be letters, digits, `_` or `-`";
  }
  if (RESERVED_MCP_SERVER_NAMES.has(name.toLowerCase())) {
    return "is the name of a server ShipIt always gives the agent";
  }
  return null;
}

export function parseServiceMcpPath(raw: unknown, label: string): string | { error: string } {
  if (raw === undefined || raw === null) return DEFAULT_SERVICE_MCP_PATH;
  if (typeof raw !== "string" || !MCP_PATH_RE.test(raw.trim())) {
    return { error: `\`${label}\` must be a URL path that starts with \`/\`, like \`/mcp\`` };
  }
  return raw.trim();
}

export function serviceMcpUrl(service: string, port: number, path: string): string {
  return `http://${service}:${port}${path}`;
}
