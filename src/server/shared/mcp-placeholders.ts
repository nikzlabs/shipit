/**
 * An MCP server's configuration stores a reference to a credential, never the
 * credential: `$secret:<agentEnv-key>` for one the user typed into the panel,
 * `$platform:<source>` for one an MCP OAuth flow holds. The value lives apart
 * from the config, so whether a server can start is a question about both.
 *
 * Shared because both halves ask it: the worker resolves the references when it
 * spawns an agent, and the orchestrator reads them back to say whether the
 * server is configured (docs/299-agent-settings-access req 3).
 */
export function substituteMcpPlaceholders(
  value: string,
  env: Record<string, string | undefined>,
  missing: string[],
): string {
  const lookup = (envKey: string): string => {
    const v = env[envKey];
    if (v === undefined || v === "") {
      missing.push(envKey);
      return "";
    }
    return v;
  };
  return value
    .replace(secretRefPattern(), (_m, key: string) => lookup(key))
    .replace(/\$platform:([a-z][a-z0-9_]*)/g, (_m, source: string) =>
      lookup(`MCP_PLATFORM_${source.toUpperCase()}`),
    );
}

/**
 * The agentEnv keys a config value refers to. Shares the pattern with the
 * substitution above so the two readers cannot drift: the orchestrator
 * reconciles stored secrets against what a config refers to (planning#565), and
 * a reference it failed to see would be a secret it deletes.
 */
export function secretKeysReferencedIn(value: string): string[] {
  return [...value.matchAll(secretRefPattern())].map((m) => m[1]);
}

function secretRefPattern(): RegExp {
  return /\$secret:([A-Za-z_][A-Za-z0-9_]*)/g;
}
