import { describe, it, expect } from "vitest";
import {
  inputKeyTreatment,
  isPlanDocumentWrite,
  COMMAND_SUMMARY_CHARS,
  INPUT_STRIP_FLOOR_BYTES,
  PLAN_DOC_PATH_MARKER,
} from "./transcript-input-policy.js";

describe("inputKeyTreatment", () => {
  const empty: Record<string, unknown> = {};

  it("keeps the keys the compact one-line tool summary draws in full", () => {
    for (const key of ["file_path", "pattern", "query", "url"]) {
      expect(inputKeyTreatment("Grep", key, empty)).toBe("keep");
      expect(inputKeyTreatment("mcp__whatever__thing", key, empty)).toBe("keep");
    }
  });

  it("shortens `command`, the one key drawn as a fixed-length prefix", () => {
    expect(inputKeyTreatment("Bash", "command", empty)).toBe("head");
    expect(inputKeyTreatment("shell", "command", empty)).toBe("head");
  });

  it("drops everything the tool-call modal alone displays", () => {
    for (const key of ["description", "timeout", "offset", "args", "body"]) {
      expect(inputKeyTreatment("Bash", key, empty)).toBe("drop");
    }
  });

  it("keeps what the subagent card draws and drops the prompt behind its disclosure", () => {
    for (const name of ["Task", "Agent"]) {
      expect(inputKeyTreatment(name, "description", empty)).toBe("keep");
      expect(inputKeyTreatment(name, "subagent_type", empty)).toBe("keep");
      expect(inputKeyTreatment(name, "prompt", empty)).toBe("drop");
    }
    expect(inputKeyTreatment("Skill", "skill", empty)).toBe("keep");
    expect(inputKeyTreatment("Skill", "args", empty)).toBe("keep");
    expect(inputKeyTreatment("Skill", "prompt", empty)).toBe("drop");
  });

  it("keeps the whole input of the tools that render it as the card itself", () => {
    for (const name of ["AskUserQuestion", "TodoWrite", "apply_patch"]) {
      for (const key of ["questions", "todos", "changes", "anything"]) {
        expect(inputKeyTreatment(name, key, empty)).toBe("keep");
      }
    }
  });

  it("keeps what the task panel draws from a Task* call and drops the description", () => {
    for (const name of ["TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]) {
      for (const key of ["taskId", "subject", "activeForm", "status"]) {
        expect(inputKeyTreatment(name, key, empty)).toBe("keep");
      }
      expect(inputKeyTreatment(name, "description", empty)).toBe("drop");
      expect(inputKeyTreatment(name, "metadata", empty)).toBe("drop");
    }
  });

  it("treats the background-task tools as ordinary tools, not to-do list tools", () => {
    for (const name of ["TaskStop", "TaskOutput"]) {
      expect(inputKeyTreatment(name, "task_id", empty)).toBe("drop");
      expect(inputKeyTreatment(name, "subject", empty)).toBe("drop");
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
    expect(inputKeyTreatment("Write", "old_string", plan)).toBe("drop");
    expect(inputKeyTreatment("Edit", "content", plan)).toBe("drop");
    expect(inputKeyTreatment("Write", "content", { file_path: "/w/.claude/p.md" })).toBe("drop");
  });

  it("drops `ExitPlanMode.plan`, which nothing renders", () => {
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
    expect(COMMAND_SUMMARY_CHARS).toBe(80);
  });

  it("floors stripping where the markers stop paying for themselves", () => {
    expect(INPUT_STRIP_FLOOR_BYTES).toBe(200);
  });
});
