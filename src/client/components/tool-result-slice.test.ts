import { describe, it, expect } from "vitest";
import {
  BASH_MAX_LINES,
  READ_MAX_LINES,
  GREP_MAX_LINES,
  GENERIC_MAX_LINES,
} from "./ToolResult.js";
import { TRANSCRIPT_SLICE_LINES } from "../../server/shared/transcript-slice.js";
import { SUBAGENT_TOOLS } from "./visual-elements.js";
import { SUBAGENT_TOOL_NAMES, SUBAGENT_REPORT_TOOL_NAMES } from "../../server/shared/transcript-slice-tools.js";

/**
 * docs/244 — the orchestrator ships only the first `TRANSCRIPT_SLICE_LINES`
 * lines of a heavy tool result; if any preview here draws more than that, it
 * would render a short body as though it were the whole thing, with no visible
 * signal. Failing here is the intended outcome — raise
 * `TRANSCRIPT_SLICE_LINES` alongside the preview.
 *
 * These previews used to be what the *transcript* drew, which is where the
 * slice size came from. They now render inside the click-opened output modal
 * (`message-tools.tsx:500`) — the transcript itself shows no output at all. So
 * the relationship this guard pins is still real, but it no longer justifies
 * the slice size: see `plan.md` → *Requirement 1 is not met*.
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
