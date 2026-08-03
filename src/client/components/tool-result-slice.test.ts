import { describe, it, expect } from "vitest";
import {
  BASH_MAX_LINES,
  READ_MAX_LINES,
  GREP_MAX_LINES,
  GENERIC_MAX_LINES,
} from "./ToolResult.js";
import { TRANSCRIPT_SLICE_LINES } from "../../server/shared/transcript-slice.js";
import { SUBAGENT_TOOLS } from "./visual-elements.js";
import { SUBAGENT_TOOL_NAMES } from "../../server/shared/transcript-slice-tools.js";

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
   * The projection exempts exactly this set from slicing because the final
   * report renders in full with no expand affordance. One definition, so the
   * exemption and the renderer cannot disagree.
   */
  it("is the same object the projection exempts", () => {
    expect(SUBAGENT_TOOLS).toBe(SUBAGENT_TOOL_NAMES);
  });
});
