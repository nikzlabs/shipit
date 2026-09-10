import { describe, it, expect } from "vitest";
import { CLAUDE_TOOL_NAMES, OPENCODE_TOOL_NAMES } from "../../../shared/agent-tool-names.js";
import { isTaskListTool } from "../../../shared/task-list-tools.js";
import { inputKeyTreatment } from "../../../shared/transcript-input-policy.js";
import {
  rendersResultContentInline,
  SUBAGENT_REPORT_TOOL_NAMES,
  SUBAGENT_TOOL_NAMES,
} from "../../../shared/transcript-slice-tools.js";
import {
  normalizeOpencodeToolCall,
  normalizeOpencodeToolResult,
  OPENCODE_TRANSCRIPT_TOOL_NAMES,
} from "./opencode-tool-normalizer.js";

describe("OPENCODE_TRANSCRIPT_TOOL_NAMES", () => {
  it("covers every advertised OpenCode tool — a new tool must decide its transcript name", () => {
    for (const name of OPENCODE_TOOL_NAMES) {
      expect(OPENCODE_TRANSCRIPT_TOOL_NAMES[name], `opencode tool ${name}`).toBeTruthy();
    }
  });

  it("maps each tool onto the Claude tool with the same meaning", () => {
    expect(OPENCODE_TRANSCRIPT_TOOL_NAMES).toEqual({
      bash: "Bash",
      edit: "Edit",
      glob: "Glob",
      grep: "Grep",
      read: "Read",
      skill: "Skill",
      task: "Agent",
      todowrite: "TodoWrite",
      webfetch: "WebFetch",
      write: "Write",
    });
    for (const [raw, transcript] of Object.entries(OPENCODE_TRANSCRIPT_TOOL_NAMES)) {
      expect(CLAUDE_TOOL_NAMES, `${raw} → ${transcript}: not in the Claude vocabulary`).toContain(
        transcript,
      );
    }
  });
});

describe("normalizeOpencodeToolCall — surface treatments (the planning#432 recognition matrix)", () => {
  it("todowrite reaches the task panel with its todos intact (the drop default was the data loss)", () => {
    const { name, input } = normalizeOpencodeToolCall("todowrite", {
      todos: [{ content: "first", status: "pending" }],
    });
    expect(isTaskListTool(name)).toBe(true);
    expect(inputKeyTreatment(name, "todos", input)).toBe("keep");
    expect(input.todos).toEqual([{ content: "first", status: "pending" }]);
  });

  it("edit gets file-path summary treatment and the snake_case diff body keys", () => {
    const { name, input } = normalizeOpencodeToolCall("edit", {
      filePath: "/w/a.ts",
      oldString: "old",
      newString: "new",
    });
    expect(inputKeyTreatment(name, "file_path", input)).toBe("keep");
    expect(input).toEqual({ file_path: "/w/a.ts", old_string: "old", new_string: "new" });
  });

  it("write gets file-path summary treatment", () => {
    const { name, input } = normalizeOpencodeToolCall("write", {
      filePath: "/w/b.md",
      content: "hi\n",
    });
    expect(inputKeyTreatment(name, "file_path", input)).toBe("keep");
    expect(input).toEqual({ file_path: "/w/b.md", content: "hi\n" });
  });

  it("task gets the subagent card and its result — the report — survives projection", () => {
    const { name, input } = normalizeOpencodeToolCall("task", {
      description: "count files",
      prompt: "Count the files in the repo root.",
      subagent_type: "general",
    });
    expect(SUBAGENT_TOOL_NAMES.has(name)).toBe(true);
    expect(SUBAGENT_REPORT_TOOL_NAMES.has(name)).toBe(true);
    expect(rendersResultContentInline(name)).toBe(true);
    expect(inputKeyTreatment(name, "description", input)).toBe("keep");
    expect(inputKeyTreatment(name, "subagent_type", input)).toBe("keep");
  });

  it("bash keeps its command head-slice", () => {
    const { name, input } = normalizeOpencodeToolCall("bash", { command: "echo hi" });
    expect(inputKeyTreatment(name, "command", input)).toBe("head");
  });

  it("skill carries its name in the client's key, not the wire's", () => {
    const { name, input } = normalizeOpencodeToolCall("skill", { name: "commit" });
    expect(name).toBe("Skill");
    expect(input).toEqual({ skill: "commit" });
    expect(inputKeyTreatment(name, "skill", input)).toBe("keep");
  });

  it("passes unknown names through untouched, camelCase keys and all", () => {
    const input = { filePath: "/x", other: 1 };
    const result = normalizeOpencodeToolCall("mcp_shipit_present", input);
    expect(result.name).toBe("mcp_shipit_present");
    expect(result.input).toBe(input);
  });

  it("does not mutate the caller's input", () => {
    const input = { filePath: "/w/a.ts", oldString: "a", newString: "b" };
    normalizeOpencodeToolCall("edit", input);
    expect(input).toEqual({ filePath: "/w/a.ts", oldString: "a", newString: "b" });
  });
});

describe("normalizeOpencodeToolResult — the task wrapper (planning#434)", () => {
  // Captured from OpenCode CLI 1.18.15 on 2026-08-18.
  const WRAPPED =
    '<task id="ses_8f214c2af" state="completed">\n<task_result>\n11\n</task_result>\n</task>';

  it("unwraps the CLI's wrapper so the persisted content IS the report", () => {
    expect(normalizeOpencodeToolResult("task", WRAPPED)).toBe("11");
  });

  it("keeps a multi-line report intact, markdown and all", () => {
    const report = "## Findings\n\n- one\n- two";
    expect(
      normalizeOpencodeToolResult(
        "task",
        `<task id="ses_1" state="completed">\n<task_result>\n${report}\n</task_result>\n</task>`,
      ),
    ).toBe(report);
  });

  it("keeps a literal </task_result> inside the report — the match takes the LAST closing pair", () => {
    const report = "the CLI emits </task_result> before closing";
    expect(
      normalizeOpencodeToolResult(
        "task",
        `<task id="ses_1" state="completed">\n<task_result>\n${report}\n</task_result>\n</task>`,
      ),
    ).toBe(report);
  });

  it("unwraps an error-state wrapper the same way — is_error styling is carried by the result block, not the tags", () => {
    expect(
      normalizeOpencodeToolResult(
        "task",
        '<task id="ses_1" state="error">\n<task_result>\nboom\n</task_result>\n</task>',
      ),
    ).toBe("boom");
  });

  it("strips the wrapper's own newlines symmetrically under CRLF", () => {
    expect(
      normalizeOpencodeToolResult(
        "task",
        '<task id="ses_1" state="completed">\r\n<task_result>\r\nhi\r\n</task_result>\r\n</task>',
      ),
    ).toBe("hi");
  });

  it("passes an unrecognized shape through untouched — the safe direction for a CLI format change", () => {
    expect(normalizeOpencodeToolResult("task", "plain text, no wrapper")).toBe(
      "plain text, no wrapper",
    );
    expect(normalizeOpencodeToolResult("task", "<task_result>orphan, no outer tag")).toBe(
      "<task_result>orphan, no outer tag",
    );
    expect(normalizeOpencodeToolResult("task", `prose before ${WRAPPED}`)).toBe(
      `prose before ${WRAPPED}`,
    );
  });

  it("does not touch other tools' output, even wrapper-shaped output", () => {
    expect(normalizeOpencodeToolResult("bash", WRAPPED)).toBe(WRAPPED);
  });
});
