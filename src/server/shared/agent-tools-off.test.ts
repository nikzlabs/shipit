import { describe, it, expect } from "vitest";
import {
  CLAUDE_TOOLS_OFF_ARGS,
  CODEX_TOOLS_OFF_ARGS,
  GROK_TOOLS_OFF_ARGS,
  OPENCODE_TOOLS_OFF_CONFIG,
  toolsOffArgs,
} from "./agent-tools-off.js";

/**
 * These assert the shape each measurement established, not vendor trivia: every
 * one of them was a way the flags could look right and still ship a populated
 * tool set.
 */
describe("tools-off shaping", () => {
  it("claude empties the tool set rather than allowlisting nothing", () => {
    // --allowedTools "" is a permission allowlist; the tools stay defined.
    expect(CLAUDE_TOOLS_OFF_ARGS).not.toContain("--allowedTools");
    expect(CLAUDE_TOOLS_OFF_ARGS[CLAUDE_TOOLS_OFF_ARGS.indexOf("--tools") + 1]).toBe("");
    expect(CLAUDE_TOOLS_OFF_ARGS).toContain("--strict-mcp-config");
  });

  it("grok denies every tool its own allowlist leaves behind", () => {
    // An empty grok allowlist is ignored, and an unknown name in one fails open,
    // so the allowlist names a real tool and the denylist then removes it.
    const allowed = GROK_TOOLS_OFF_ARGS[GROK_TOOLS_OFF_ARGS.indexOf("--tools") + 1];
    expect(allowed).not.toBe("");
    const denied = GROK_TOOLS_OFF_ARGS[GROK_TOOLS_OFF_ARGS.indexOf("--disallowed-tools") + 1]
      .split(",");
    for (const tool of allowed.split(",")) expect(denied).toContain(tool);
    // The MCP meta-tools survive an allowlist and must be named explicitly.
    expect(denied).toContain("search_tool");
    expect(denied).toContain("use_tool");
  });

  it("codex removes the shell tool and the native web search", () => {
    expect(CODEX_TOOLS_OFF_ARGS).toContain("features.shell_tool=false");
    // The native web-search tool answers only to the top-level key; the one
    // under `tools.` parses and does nothing (measured).
    expect(CODEX_TOOLS_OFF_ARGS).toContain('web_search="disabled"');
    expect(CODEX_TOOLS_OFF_ARGS).not.toContain("tools.web_search=false");
    // Both are structs in 0.154.0; a bare boolean fails config load outright.
    expect(CODEX_TOOLS_OFF_ARGS).toContain("tools.update_plan={enabled=false}");
    expect(CODEX_TOOLS_OFF_ARGS).toContain("tools.experimental_request_user_input={enabled=false}");
    // Each override is a -c pair, since these must precede the subcommand.
    expect(CODEX_TOOLS_OFF_ARGS.filter((a) => a === "-c")).toHaveLength(
      CODEX_TOOLS_OFF_ARGS.length / 2,
    );
  });

  it("opencode empties its set through the config wildcard", () => {
    expect(OPENCODE_TOOLS_OFF_CONFIG).toEqual({ "*": false });
    expect(toolsOffArgs("opencode")).toEqual([]);
  });

  it("every harness has an answer", () => {
    expect(toolsOffArgs("claude")).toBe(CLAUDE_TOOLS_OFF_ARGS);
    expect(toolsOffArgs("codex")).toBe(CODEX_TOOLS_OFF_ARGS);
    expect(toolsOffArgs("grok")).toBe(GROK_TOOLS_OFF_ARGS);
  });
});
