import { describe, it, expect } from "vitest";
import {
  BASH_MAX_LINES,
  READ_MAX_LINES,
  GREP_MAX_LINES,
  GENERIC_MAX_LINES,
} from "./ToolResult.js";
import { TRANSCRIPT_SLICE_LINES } from "../../server/shared/transcript-slice.js";
import { SUBAGENT_TOOLS } from "./visual-elements.js";
import {
  SUBAGENT_TOOL_NAMES,
  SUBAGENT_REPORT_TOOL_NAMES,
  WHOLE_RESULT_TOOL_NAMES,
  rendersResultContentInline,
  shipsResultBodyWhole,
} from "../../server/shared/transcript-slice-tools.js";

/**
 * docs/244 — the orchestrator ships only the first `TRANSCRIPT_SLICE_LINES`
 * lines of a heavy tool result; if any preview here draws more than that, it
 * would render a short body as though it were the whole thing, with no visible
 * signal. Failing here is the intended outcome — raise
 * `TRANSCRIPT_SLICE_LINES` alongside the preview.
 *
 * These previews render inside the click-opened output modal, not the
 * transcript — which is why a modal-only result now ships NO body at all
 * (`rendersResultContentInline`, asserted below) rather than a 40-line slice.
 * The slice still governs the cases that DO render inline and the conservative
 * unknown-tool fallback, so this relationship stays load-bearing.
 */
describe("inline previews fit inside the server slice", () => {
  const caps = {
    BASH_MAX_LINES,
    READ_MAX_LINES,
    GREP_MAX_LINES,
    GENERIC_MAX_LINES,
  };

  for (const [name, value] of Object.entries(caps)) {
    it(`${name} (${value}) is within TRANSCRIPT_SLICE_LINES (${TRANSCRIPT_SLICE_LINES})`, () => {
      expect(value).toBeLessThanOrEqual(TRANSCRIPT_SLICE_LINES);
    });
  }

  it("keeps headroom over the largest preview", () => {
    expect(TRANSCRIPT_SLICE_LINES).toBeGreaterThan(Math.max(...Object.values(caps)));
  });
});

describe("subagent tool set", () => {

  it("is the same object the client extracts standalone elements from", () => {
    expect(SUBAGENT_TOOLS).toBe(SUBAGENT_TOOL_NAMES);
  });

  it("is a subset of the tools that render as standalone elements", () => {
    for (const name of SUBAGENT_REPORT_TOOL_NAMES) {
      expect(SUBAGENT_TOOLS.has(name)).toBe(true);
    }
  });

  it("covers the tool name the Claude CLI actually emits for a subagent", () => {

    // never `Task`. `Task` stays for transcripts persisted before docs/109.
    expect(SUBAGENT_REPORT_TOOL_NAMES.has("Agent")).toBe(true);
    expect(SUBAGENT_REPORT_TOOL_NAMES.has("Task")).toBe(true);
  });

  it("excludes Skill, which renders no report", () => {
    expect(SUBAGENT_REPORT_TOOL_NAMES.has("Skill")).toBe(false);
  });
});

describe("rendersResultContentInline matches what the transcript actually reads", () => {
  it("is true for the subagent report tools — SubagentCall renders it in full", () => {
    for (const name of SUBAGENT_REPORT_TOOL_NAMES) {
      expect(rendersResultContentInline(name)).toBe(true);
    }
  });

  it("is true for AskUserQuestion — the chosen answer comes from result content", () => {
    expect(rendersResultContentInline("AskUserQuestion")).toBe(true);
  });

  it("is true for every present-tool name form — the artifact id is parsed from the result", () => {
    for (const name of ["present", "mcp__shipit__present", "mcp__shipit-present__present"]) {
      expect(rendersResultContentInline(name)).toBe(true);
    }
  });

  it("is false for ordinary tools, whose output only ever renders in the modal", () => {
    for (const name of ["Bash", "Read", "Grep", "Glob", "Edit", "Write", "WebFetch"]) {
      expect(rendersResultContentInline(name)).toBe(false);
    }
  });

  it("is false for ExitPlanMode, which reads result EXISTENCE and not content", () => {

    expect(rendersResultContentInline("ExitPlanMode")).toBe(false);
  });

  it("is true for an unresolvable tool name — the safe direction is to ship it", () => {
    expect(rendersResultContentInline(undefined)).toBe(true);
  });

  it("is false for Skill, which renders no result content at all", () => {

    expect(SUBAGENT_TOOL_NAMES.has("Skill")).toBe(true);
    expect(rendersResultContentInline("Skill")).toBe(false);
  });
});

describe("shipsResultBodyWhole is the no-recovery set", () => {

  it("excludes the subagent report tools, which now have a modal to recover from", () => {
    for (const name of SUBAGENT_REPORT_TOOL_NAMES) {
      expect(shipsResultBodyWhole(name)).toBe(false);

      // bounded but must not be emptied the way a modal-only result is.
      expect(rendersResultContentInline(name)).toBe(true);
    }
  });

  it("covers AskUserQuestion — the Ask branch returns before the output modal", () => {

    expect(shipsResultBodyWhole("AskUserQuestion")).toBe(true);
  });

  it("excludes the present tool, whose id survives a slice", () => {
    for (const name of ["present", "mcp__shipit__present"]) {
      expect(rendersResultContentInline(name)).toBe(true);
      expect(shipsResultBodyWhole(name)).toBe(false);
    }
  });

  it("excludes ExitPlanMode and ordinary tools", () => {
    for (const name of ["ExitPlanMode", "Bash", "Read", "Edit"]) {
      expect(shipsResultBodyWhole(name)).toBe(false);
    }
  });

  /**
   * `Skill` sits in the LAYOUT set, and the client cap used to key off that
   * set — so it spared `Skill` (which renders no report) while capping
   * `AskUserQuestion` (which cannot recover). Both halves are fixed by the two
   * sides reading this one.
   */
  it("excludes Skill, which the layout set contains but which renders no report", () => {
    expect(SUBAGENT_TOOL_NAMES.has("Skill")).toBe(true);
    expect(shipsResultBodyWhole("Skill")).toBe(false);
  });

  it("is false for an unresolvable tool name", () => {

    expect(shipsResultBodyWhole(undefined)).toBe(false);
  });

  it("is a subset of what the transcript reads inline", () => {

    for (const name of WHOLE_RESULT_TOOL_NAMES) {
      expect(rendersResultContentInline(name)).toBe(true);
    }
  });
});
