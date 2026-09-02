/**
 * Guards for the OpenCode → transcript-vocabulary normalization (planning#432).
 *
 * These tests assert TREATMENTS against the real registries, not spellings
 * against a copy — the planning#337 lesson (two hand-kept lists can agree and
 * be jointly wrong). If a registry migrates its vocabulary out from under the
 * normalizer, the surface-treatment guards below go red naming the surface,
 * instead of the transcript silently degrading to generic rows.
 *
 * The `diffStats` guard (DIFF_INPUT_TOOLS is orchestrator-private) lives in
 * `orchestrator/integration_tests/opencode-recognition-projection.test.ts` —
 * the layer boundary keeps it out of this file.
 */

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
    // The semantic oracle, spelled out: a mapping that renames a shell tool
    // into a file tool (or onto a name Claude's registry doesn't know) passes
    // every treatment guard below and still puts the wrong card on screen.
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
    // inputKeyTreatment's default is `drop` with NO fetch path back — the
    // exact registry whose miss stripped every todos array off the wire.
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
    // `false` here empties the result body that IS the subagent's report.
    expect(rendersResultContentInline(name)).toBe(true);
    expect(inputKeyTreatment(name, "description", input)).toBe("keep");
    expect(inputKeyTreatment(name, "subagent_type", input)).toBe("keep");
  });

  it("bash keeps its command head-slice", () => {
    const { name, input } = normalizeOpencodeToolCall("bash", { command: "echo hi" });
    expect(inputKeyTreatment(name, "command", input)).toBe("head");
  });

  it("skill carries its name in the client's key, not the wire's", () => {
    // OpenCode's skill tool names the skill in `input.name` (Schema.Struct({
    // name })); the client's Skill card and the projection keep-list read
    // Claude's `input.skill` — an untranslated `name` rendered "Skill:
    // unknown" and would be dropped by inputKeyTreatment's default.
    const { name, input } = normalizeOpencodeToolCall("skill", { name: "commit" });
    expect(name).toBe("Skill");
    expect(input).toEqual({ skill: "commit" });
    expect(inputKeyTreatment(name, "skill", input)).toBe("keep");
  });

  it("passes unknown names through untouched, camelCase keys and all", () => {
    // MCP and future tools: renaming keys on a tool we don't know would
    // corrupt its modal display, so the call must come back as-is.
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
  // Verbatim result shape from OpenCode CLI 1.18.15 (docs/272 run 2026-08-18):
  // the wrapper is one blank-line-free CommonMark HTML block, which the
  // client's skipHtml markdown drops WHOLE — report included.
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
    // A wrapped error that does NOT match the regex renders raw in the error
    // panel (`<pre>`, no markdown) — visible degradation, which is the
    // intended pass-through stance, not a bug to blank out.
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
