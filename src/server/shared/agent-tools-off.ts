import type { AgentId } from "./types/agent-types.js";

/**
 * Running a one-shot CLI with no tools, per harness (docs/299 req 8).
 *
 * Every entry was measured on 2026-09-13 against the pinned CLIs in
 * `docker/agent-cli/package.json` by pointing each harness at a stand-in API
 * server and counting the tool definitions in the request body it sent. That
 * matters because the help text is not the behaviour: grok documents `--tools`
 * as an allowlist, and `--tools ""` still sent all 27 of its built-ins, while an
 * unrecognised name in the allowlist falls back to the full set rather than
 * failing. Re-measure the same way before changing anything here.
 */
export const CLAUDE_TOOLS_OFF_ARGS: readonly string[] = [
  // `--allowedTools ""` is a permission allowlist and leaves the tool set populated.
  "--tools", "",
  "--strict-mcp-config",
];

/**
 * Codex has no single flag; these seven overrides together take its request from
 * 9 tool definitions to 0. `--disable <feature>` is the documented equivalent of
 * `-c features.<name>=false`, and the `-c` form is used because these must
 * precede the `app-server` subcommand. Two traps, both measured: the
 * Responses-native web-search tool is disabled by the TOP-LEVEL `web_search`
 * key and ignores `tools.web_search=false` entirely, and `update_plan` and
 * `experimental_request_user_input` are structs that reject a bare boolean at
 * config load.
 */
export const CODEX_TOOLS_OFF_ARGS: readonly string[] = [
  "-c", "features.shell_tool=false",
  "-c", "features.multi_agent=false",
  "-c", "features.goals=false",
  "-c", "features.view_image=false",
  "-c", 'web_search="disabled"',
  "-c", "tools.update_plan={enabled=false}",
  "-c", "tools.experimental_request_user_input={enabled=false}",
];

/**
 * Grok needs both halves. The allowlist alone leaves `read_file` plus the
 * always-on MCP meta-tools; the denylist alone has nothing to subtract from.
 * Together the request carries no `tools` field. `read_file` is named only to
 * give the allowlist a tool that exists — an unknown name fails open.
 */
export const GROK_TOOLS_OFF_ARGS: readonly string[] = [
  "--tools", "read_file",
  "--disallowed-tools", "read_file,search_tool,use_tool,Agent",
];

/** OpenCode takes no tool flags; its config's wildcard entry empties the set. */
export const OPENCODE_TOOLS_OFF_CONFIG: Readonly<Record<string, boolean>> = { "*": false };

/** Empty for OpenCode, which is configured through its config file instead. */
export function toolsOffArgs(agentId: AgentId): readonly string[] {
  switch (agentId) {
    case "claude": return CLAUDE_TOOLS_OFF_ARGS;
    case "codex": return CODEX_TOOLS_OFF_ARGS;
    case "grok": return GROK_TOOLS_OFF_ARGS;
    case "opencode": return [];
  }
}
