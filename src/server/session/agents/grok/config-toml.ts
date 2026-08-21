/**
 * The per-turn `config.toml` the Grok adapter writes into `$GROK_HOME`
 * (docs/274-grok-build-harness).
 *
 * **Why a hand-rolled renderer rather than a TOML library.** The document is
 * ShipIt's own and tiny — one `[mcp_servers.<name>]` table per server, with
 * string/bool/array-of-string values and one nested `env` / `headers` table.
 * Adding a dependency for that costs a pinned package and a 7-day age window
 * (the dependency policy) to serialize a shape this file can state in full. The shape itself is not invented: it was read off a real `grok mcp add`
 * run, whose output this renderer reproduces.
 *
 * Every string is escaped through {@link tomlString}. That is the whole risk
 * surface here — an MCP server's `args` or `env` can hold a user's own value
 * containing a quote or a backslash, and an unescaped one does not produce a
 * broken server, it produces a config the CLI parses as something else.
 */

/**
 * One MCP server as Grok's config wants it. `command`/`args` for stdio,
 * `transport` + `url` for remote — the two shapes `grok mcp add` writes.
 */
export interface GrokMcpServer {
  command?: string;
  args?: string[];
  enabled?: boolean;
  env?: Record<string, string>;
  transport?: "http" | "sse";
  url?: string;
  headers?: Record<string, string>;
}

/** A TOML basic string: quote it, escaping backslash, quote and the controls. */
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

/**
 * Render the whole config document.
 *
 * ShipIt owns this file for the duration of a turn and the adapter restores
 * whatever was there afterwards, so the document states everything it wants
 * rather than merging: `[cli] auto_update = false` is written here as well as
 * being passed by flag and env, because a config the CLI reads is the layer a
 * flag cannot cover for anything the CLI spawns on its own.
 */
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
    // Nested tables go LAST: everything after a `[a.b]` header belongs to that
    // table, so a scalar emitted after one would silently land inside it.
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
