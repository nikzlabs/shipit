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
  /**
   * Layout set: one definition shared by the renderer's element extraction and
   * anything server-side that reasons about subagent calls.
   */
  it("is the same object the client extracts standalone elements from", () => {
    expect(SUBAGENT_TOOLS).toBe(SUBAGENT_TOOL_NAMES);
  });

  /**
   * docs/109 — the report set is what `MessageToolUse` routes to `SubagentCall`
   * AND what the projection exempts from slicing. Those two jobs read the same
   * constant on purpose: a name that renders a full report but gets sliced
   * loses text irrecoverably, and a name that is exempted but renders nothing
   * ships an unbounded body for no reason (which is what `Skill` did).
   */
  it("is a subset of the tools that render as standalone elements", () => {
    for (const name of SUBAGENT_REPORT_TOOL_NAMES) {
      expect(SUBAGENT_TOOLS.has(name)).toBe(true);
    }
  });

  it("covers the tool name the Claude CLI actually emits for a subagent", () => {
    // Verified against Claude Code CLI 2.1.219: the tool arrives as `Agent`,
    // never `Task`. `Task` stays for transcripts persisted before docs/109.
    expect(SUBAGENT_REPORT_TOOL_NAMES.has("Agent")).toBe(true);
    expect(SUBAGENT_REPORT_TOOL_NAMES.has("Task")).toBe(true);
  });

  it("excludes Skill, which renders no report", () => {
    expect(SUBAGENT_REPORT_TOOL_NAMES.has("Skill")).toBe(false);
  });
});

/**
 * The drift guard for the requirement-1 fix. `rendersResultContentInline` is the
 * projection's answer to "does anything draw this result's content without a
 * click?" — and getting it wrong is silent in both directions: a `false` for a
 * tool the transcript renders blanks a card with no fetch path behind it, and a
 * `true` for one it doesn't ships bytes nobody ever sees.
 *
 * Each case below is pinned to the call site that reads the content, so a
 * renderer that stops reading it (or starts) shows up here.
 */
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
    // `resolved={!!result}` survives an emptied body, so there is nothing to keep.
    expect(rendersResultContentInline("ExitPlanMode")).toBe(false);
  });

  it("is true for an unresolvable tool name — the safe direction is to ship it", () => {
    expect(rendersResultContentInline(undefined)).toBe(true);
  });

  it("is false for Skill, which renders no result content at all", () => {
    // Skill sits in the layout set but renders neither a report nor a preview.
    expect(SUBAGENT_TOOL_NAMES.has("Skill")).toBe(true);
    expect(rendersResultContentInline("Skill")).toBe(false);
  });
});

/**
 * SHI-291 — the set every size bound in this feature has to agree on.
 *
 * `rendersResultContentInline` answers "does anything draw this without a
 * click"; this one answers the sharper question "and if we cut it, can the user
 * ever get the rest back?". Where the answer is no, the body ships whole — a
 * larger payload beats destroying text.
 */
describe("shipsResultBodyWhole is the no-recovery set", () => {
  /**
   * docs/109 req 7/8 — the report tools were the other member and left when the
   * card grew a *Show the full report* modal. Membership is "cutting it destroys
   * text with no way back", and the modal IS the way back: the report is clamped
   * by `sliceSubagentReport` and the rest fetched from
   * `/tool-results/:toolUseId`. If that modal is ever removed, this is where the
   * report has to come back.
   */
  it("excludes the subagent report tools, which now have a modal to recover from", () => {
    for (const name of SUBAGENT_REPORT_TOOL_NAMES) {
      expect(shipsResultBodyWhole(name)).toBe(false);
      // Still drawn without a click — the clamped head — so the body may be
      // bounded but must not be emptied the way a modal-only result is.
      expect(rendersResultContentInline(name)).toBe(true);
    }
  });

  it("covers AskUserQuestion — the Ask branch returns before the output modal", () => {
    // The regression itself: a >16 KB free-form answer lost its tail with no
    // click, no modal and no fetch to recover it.
    expect(shipsResultBodyWhole("AskUserQuestion")).toBe(true);
  });

  /**
   * The counter-case that keeps the set narrow. `present` reads result content
   * inline too, but only an artifact id from the head of a compact payload its
   * own producer controls — a slice preserves that, so exempting it would ship
   * bytes for nothing.
   */
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
    // Unlike `rendersResultContentInline`, whose safe direction is to ship, the
    // safe direction here is to bound: an unknown name gets the ordinary slice,
    // which the unknown-name fallback already keeps generous.
    expect(shipsResultBodyWhole(undefined)).toBe(false);
  });

  it("is a subset of what the transcript reads inline", () => {
    // A body that ships whole but that nothing renders would be pure waste.
    for (const name of WHOLE_RESULT_TOOL_NAMES) {
      expect(rendersResultContentInline(name)).toBe(true);
    }
  });
});
