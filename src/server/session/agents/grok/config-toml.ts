export interface GrokMcpServer {
  command?: string;
  args?: string[];
  enabled?: boolean;
  env?: Record<string, string>;
  transport?: "http" | "sse";
  url?: string;
  headers?: Record<string, string>;
}

function tomlString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

// Config also disables updates for children that do not inherit the CLI flag.
export function renderGrokConfigToml(servers: Record<string, GrokMcpServer>): string {
  const lines: string[] = [
    "# Written per turn by ShipIt (docs/274). Do not edit — it is replaced on",
    "# every turn and restored to its previous contents afterwards.",
    "",
    "[cli]",
    "auto_update = false",
  ];

  for (const [name, server] of Object.entries(servers)) {
    lines.push("", `[mcp_servers.${tomlString(name)}]`);
    if (server.transport) lines.push(`transport = ${tomlString(server.transport)}`);
    if (server.url !== undefined) lines.push(`url = ${tomlString(server.url)}`);
    if (server.command !== undefined) lines.push(`command = ${tomlString(server.command)}`);
    if (server.args !== undefined) lines.push(`args = ${tomlStringArray(server.args)}`);
    if (server.enabled !== undefined) lines.push(`enabled = ${server.enabled ? "true" : "false"}`);
    // Nested tables must follow scalars: a header changes all subsequent keys' scope.
    if (server.env && Object.keys(server.env).length > 0) {
      lines.push(`[mcp_servers.${tomlString(name)}.env]`);
      for (const [key, value] of Object.entries(server.env)) {
        lines.push(`${tomlString(key)} = ${tomlString(value)}`);
      }
    }
    if (server.headers && Object.keys(server.headers).length > 0) {
      lines.push(`[mcp_servers.${tomlString(name)}.headers]`);
      for (const [key, value] of Object.entries(server.headers)) {
        lines.push(`${tomlString(key)} = ${tomlString(value)}`);
      }
    }
  }

  return `${lines.join("\n")}\n`;
}
