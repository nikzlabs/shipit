import { describe, it, expect } from "vitest";
import {
  inputKeyTreatment,
  isPlanDocumentWrite,
  COMMAND_SUMMARY_CHARS,
  INPUT_STRIP_FLOOR_BYTES,
  PLAN_DOC_PATH_MARKER,
} from "./transcript-input-policy.js";

/**
 * The input-side counterpart of the `rendersResultContentInline` drift guard
 * (SHI-296). Each case below is pinned to a *call site*, not to a hunch about
 * what a tool's input contains — the failure mode this feature has hit twice is
 * an answer that was true of the renderer when it was written and stopped being
 * true when the renderer moved.
 *
 * The same limitation applies as on the result side, and is worth stating
 * plainly: this is a manual enumeration. A *new* component that draws some
 * other tool's input inline will not fail this build. What it does buy is that
 * changing one of the enumerated renderers without changing the policy shows up
 * as a red test naming the key.
 */
describe("inputKeyTreatment", () => {
  const empty: Record<string, unknown> = {};

  it("keeps the keys the compact one-line tool summary draws in full", () => {
    // message-tools.tsx → filePathText / patternText / queryText / urlText.
    for (const key of ["file_path", "pattern", "query", "url"]) {
      expect(inputKeyTreatment("Grep", key, empty)).toBe("keep");
      // Not tool-specific: the same one-liner renders every fall-through tool.
      expect(inputKeyTreatment("mcp__whatever__thing", key, empty)).toBe("keep");
    }
  });

  it("shortens `command`, the one key drawn as a fixed-length prefix", () => {
    // The renderer's own bound is a literal `slice(0, COMMAND_SUMMARY_CHARS)`,
    // which is what makes shortening it provably invisible.
    expect(inputKeyTreatment("Bash", "command", empty)).toBe("head");
    expect(inputKeyTreatment("shell", "command", empty)).toBe("head");
  });

  it("drops everything the tool-call modal alone displays", () => {
    for (const key of ["description", "timeout", "offset", "args", "body"]) {
      expect(inputKeyTreatment("Bash", key, empty)).toBe("drop");
    }
  });

  it("keeps what the subagent card draws and drops the prompt behind its disclosure", () => {
    // SubagentCall.tsx reads description/subagent_type inline; the prompt is
    // collapsed, and its toggle is labelled from `inputChars` instead.
    for (const name of ["Task", "Agent"]) {
      expect(inputKeyTreatment(name, "description", empty)).toBe("keep");
      expect(inputKeyTreatment(name, "subagent_type", empty)).toBe("keep");
      expect(inputKeyTreatment(name, "prompt", empty)).toBe("drop");
    }
    // MessageToolUse.tsx's Skill chip.
    expect(inputKeyTreatment("Skill", "skill", empty)).toBe("keep");
    expect(inputKeyTreatment("Skill", "args", empty)).toBe("keep");
    expect(inputKeyTreatment("Skill", "prompt", empty)).toBe("drop");
  });

  it("keeps the whole input of the tools that render it as the card itself", () => {
    // These branches return before any modal, so a dropped key would be
    // unreachable rather than deferred — the argument that put
    // `AskUserQuestion` in `WHOLE_RESULT_TOOL_NAMES` on the result side.
    // `apply_patch` is here for a different reason: its inline `+N -M` is
    // derived from the diffs, so the bodies ARE the summary.
    for (const name of ["AskUserQuestion", "TodoWrite", "apply_patch"]) {
      for (const key of ["questions", "todos", "changes", "anything"]) {
        expect(inputKeyTreatment(name, key, empty)).toBe("keep");
      }
    }
  });

  it("keeps the present card's title and nothing else", () => {
    for (const name of ["present", "mcp__shipit__present", "mcp__shipit-present__present"]) {
      expect(inputKeyTreatment(name, "title", empty)).toBe("keep");
      expect(inputKeyTreatment(name, "file", empty)).toBe("drop");
    }
  });

  it("drops an Edit/Write file body — the summary is `diffStats`, not the text", () => {
    for (const key of ["content", "old_string", "new_string"]) {
      expect(inputKeyTreatment("Edit", key, empty)).toBe("drop");
      expect(inputKeyTreatment("Write", key, empty)).toBe("drop");
    }
    expect(inputKeyTreatment("Write", "file_path", empty)).toBe("keep");
  });

  it("keeps a plan document's body, which PlanApproval renders inline", () => {
    const plan = { file_path: `/w${PLAN_DOC_PATH_MARKER}p.md` };
    expect(inputKeyTreatment("Write", "content", plan)).toBe("keep");
    // Narrow: only the body, only a Write, only that path.
    expect(inputKeyTreatment("Write", "old_string", plan)).toBe("drop");
    expect(inputKeyTreatment("Edit", "content", plan)).toBe("drop");
    expect(inputKeyTreatment("Write", "content", { file_path: "/w/.claude/p.md" })).toBe("drop");
  });

  it("drops `ExitPlanMode.plan`, which nothing renders", () => {
    // Deliberate, and the one entry that is an *absence* of a render path
    // rather than a presence: `PlanApproval` sources its text from the plan
    // document Write above, and the ExitPlanMode branch returns before the
    // tool-call modal. Requirement 1 is the whole argument.
    expect(inputKeyTreatment("ExitPlanMode", "plan", empty)).toBe("drop");
  });
});

describe("isPlanDocumentWrite", () => {
  it("matches a Write anywhere under a .claude/plans/ path", () => {
    expect(isPlanDocumentWrite("Write", { file_path: "/workspace/.claude/plans/x.md" })).toBe(true);
    expect(isPlanDocumentWrite("Write", { file_path: ".claude/plans/x.md" })).toBe(true);
  });

  it("does not match another tool, another path, or a missing path", () => {
    expect(isPlanDocumentWrite("Edit", { file_path: "/w/.claude/plans/x.md" })).toBe(false);
    expect(isPlanDocumentWrite("Write", { file_path: "/w/plans/x.md" })).toBe(false);
    expect(isPlanDocumentWrite("Write", {})).toBe(false);
  });
});

describe("the constants the renderers share", () => {
  it("bounds `command` at exactly what the tool line slices to", () => {
    // Not an arbitrary budget: `message-tools.tsx` imports this same constant
    // for its `slice()`, so the projection and the renderer cannot disagree.
    expect(COMMAND_SUMMARY_CHARS).toBe(80);
  });

  it("floors stripping where the markers stop paying for themselves", () => {
    expect(INPUT_STRIP_FLOOR_BYTES).toBe(200);
  });
});
