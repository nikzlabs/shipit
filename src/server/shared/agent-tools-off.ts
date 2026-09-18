import type { AgentId } from "./types/agent-types.js";

/**
 * Running a one-shot CLI with no tools, per harness (docs/299 req 8).
 *
 * Every entry was measured on 2026-09-13 against the pinned CLIs — four in
 * `docker/agent-cli/package.json`, antigravity in
 * `docker/agent-cli/install-agent-clis.sh` — by pointing each harness at a
 * stand-in API server and counting the tool definitions in the request body it
 * sent. That
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

/**
 * Antigravity was measured the same way and has no mechanism that empties its
 * tool set, so a tools-off run is refused instead (planning#546). Every
 * configuration tried on the pinned 1.1.27 sent the same 11 tool definitions as
 * the no-flags control, including a deny-everything permissions file — that is
 * an approval gate and leaves the definitions in place, the same trap as
 * Claude's `--allowedTools ""`. What was tried, and the captures:
 * `docs/301-antigravity-harness/probes/tools-off-1127.json`. Re-measure only
 * against a newer pinned version. Refusing degrades well:
 * docs/299-direct-provider-calls req 9 inserts the raw transcript when a
 * cleanup run cannot finish.
 */
export const ANTIGRAVITY_TOOLS_OFF_REFUSAL =
  "Antigravity has no way to run with its tools off — every configuration measured still"
  + " sends its full tool set — so the run was refused rather than started with every tool live.";

const TOOLS_OFF_REFUSALS = new Map<AgentId, string>([
  ["antigravity", ANTIGRAVITY_TOOLS_OFF_REFUSAL],
]);

/** Why this harness cannot run with its tools off, or undefined when it can. */
export function toolsOffRefusal(agentId: AgentId): string | undefined {
  return TOOLS_OFF_REFUSALS.get(agentId);
}

/**
 * Empty for OpenCode, which is configured through its config file instead.
 * Throws for a harness `toolsOffRefusal` names: an argument list cannot express
 * a refusal, and a caller reaching for args must fail loudly rather than spawn.
 */
export function toolsOffArgs(agentId: AgentId): readonly string[] {
  switch (agentId) {
    case "claude": return CLAUDE_TOOLS_OFF_ARGS;
    case "codex": return CODEX_TOOLS_OFF_ARGS;
    case "grok": return GROK_TOOLS_OFF_ARGS;
    case "opencode": return [];
    case "antigravity": throw new Error(ANTIGRAVITY_TOOLS_OFF_REFUSAL);
  }
}
