/**
 * Guards for the Grok → transcript-vocabulary normalization (planning#437).
 *
 * These tests assert TREATMENTS against the real registries, not spellings
 * against a copy — the planning#337 lesson (two hand-kept lists can agree and
 * be jointly wrong). If a registry migrates its vocabulary out from under the
 * normalizer, the surface-treatment guards below go red naming the surface,
 * instead of the transcript silently degrading to generic rows.
 *
 * The `diffStats` guard (DIFF_INPUT_TOOLS is orchestrator-private) lives in
 * `orchestrator/integration_tests/grok-recognition-projection.test.ts` — the
 * layer boundary keeps it out of this file.
 */

import { describe, it, expect } from "vitest";
import { CLAUDE_TOOL_NAMES, GROK_TOOL_NAMES } from "../../../shared/agent-tool-names.js";
import { isTaskListTool } from "../../../shared/task-list-tools.js";
import { inputKeyTreatment } from "../../../shared/transcript-input-policy.js";
import {
  rendersResultContentInline,
  SUBAGENT_REPORT_TOOL_NAMES,
  SUBAGENT_TOOL_NAMES,
} from "../../../shared/transcript-slice-tools.js";
import {
  GROK_TRANSCRIPT_TOOL_NAMES,
  GROK_UNNORMALIZED_INTERACTIVE_TOOLS,
  normalizeGrokToolCall,
  normalizeGrokToolResult,
} from "./grok-tool-normalizer.js";

describe("GROK_TRANSCRIPT_TOOL_NAMES", () => {
  it("keeps the normalized table and the interactive exclusion list disjoint", () => {
    // A name cannot sit in both tables: normalized means renamed on the wire,
    // excluded means deliberately left raw.
    for (const name of GROK_UNNORMALIZED_INTERACTIVE_TOOLS) {
      expect(name in GROK_TRANSCRIPT_TOOL_NAMES, `grok tool ${name} is in both tables`).toBe(false);
    }
  });

  it("names only advertised Grok tools — both tables draw from GROK_TOOL_NAMES", () => {
    for (const name of [...Object.keys(GROK_TRANSCRIPT_TOOL_NAMES), ...GROK_UNNORMALIZED_INTERACTIVE_TOOLS]) {
      expect(GROK_TOOL_NAMES, `${name} is not an advertised grok tool`).toContain(name);
    }
  });

  it("maps each tool onto the Claude tool with the same meaning", () => {
    // The semantic oracle, spelled out: a mapping that renames a shell tool
    // into a file tool (or onto a name Claude's registry doesn't know) passes
    // every treatment guard below and still puts the wrong card on screen.
    expect(GROK_TRANSCRIPT_TOOL_NAMES).toEqual({
      grep: "Grep",
      list_dir: "Glob",
      monitor: "Monitor",
      read_file: "Read",
      run_terminal_command: "Bash",
      scheduler_create: "CronCreate",
      scheduler_delete: "CronDelete",
      scheduler_list: "CronList",
      search_replace: "Edit",
      search_tool: "ToolSearch",
      spawn_subagent: "Agent",
      todo_write: "TodoWrite",
      web_search: "WebSearch",
      workflow: "Workflow",
      write: "Write",
    });
    for (const [raw, transcript] of Object.entries(GROK_TRANSCRIPT_TOOL_NAMES)) {
      expect(CLAUDE_TOOL_NAMES, `${raw} → ${transcript}: not in the Claude vocabulary`).toContain(
        transcript,
      );
    }
  });
});

describe("normalizeGrokToolCall — surface treatments (the docs/272 recognition matrix)", () => {
  it("todo_write reaches the task panel with todos, merge and item ids intact", () => {
    // The drop default was the data loss: the RED run showed `todos` stripped
    // off the wire, and the panel is the one surface with no fetch path back.
    // `merge` and the item `id`s must survive too — the fold patches by them.
    const { name, input } = normalizeGrokToolCall("todo_write", {
      todos: [{ id: "1", content: "first", status: "pending" }],
      merge: false,
    });
    expect(isTaskListTool(name)).toBe(true);
    expect(inputKeyTreatment(name, "todos", input)).toBe("keep");
    expect(inputKeyTreatment(name, "merge", input)).toBe("keep");
    expect(input.todos).toEqual([{ id: "1", content: "first", status: "pending" }]);
  });

  it("search_replace becomes an Edit with its already-snake_case body keys untouched", () => {
    const { name, input } = normalizeGrokToolCall("search_replace", {
      file_path: "/w/a.ts",
      old_string: "old",
      new_string: "new",
    });
    expect(name).toBe("Edit");
    expect(inputKeyTreatment(name, "file_path", input)).toBe("keep");
    expect(input).toEqual({ file_path: "/w/a.ts", old_string: "old", new_string: "new" });
  });

  it("write gets file-path summary treatment", () => {
    const { name, input } = normalizeGrokToolCall("write", {
      file_path: "/w/b.md",
      content: "hi\n",
    });
    expect(name).toBe("Write");
    expect(inputKeyTreatment(name, "file_path", input)).toBe("keep");
  });

  it("read_file's target_file becomes the file_path the one-line summary draws", () => {
    const { name, input } = normalizeGrokToolCall("read_file", { target_file: "package.json" });
    expect(name).toBe("Read");
    expect(input).toEqual({ file_path: "package.json" });
    expect(inputKeyTreatment(name, "file_path", input)).toBe("keep");
  });

  it("list_dir's target_directory becomes Glob's path", () => {
    const { name, input } = normalizeGrokToolCall("list_dir", { target_directory: "/w" });
    expect(name).toBe("Glob");
    expect(input).toEqual({ path: "/w" });
  });

  it("spawn_subagent gets the subagent card and its result — the report — survives projection", () => {
    const { name, input } = normalizeGrokToolCall("spawn_subagent", {
      description: "count files",
      prompt: "Count the files in the repo root.",
      subagent_type: "explore",
      background: false,
    });
    expect(SUBAGENT_TOOL_NAMES.has(name)).toBe(true);
    expect(SUBAGENT_REPORT_TOOL_NAMES.has(name)).toBe(true);
    // `false` here empties the result body that IS the subagent's report.
    expect(rendersResultContentInline(name)).toBe(true);
    expect(inputKeyTreatment(name, "description", input)).toBe("keep");
    expect(inputKeyTreatment(name, "subagent_type", input)).toBe("keep");
  });

  it("run_terminal_command keeps its command head-slice", () => {
    const { name, input } = normalizeGrokToolCall("run_terminal_command", {
      command: "echo conversion-probe",
      description: "Echo the probe string",
    });
    expect(name).toBe("Bash");
    expect(inputKeyTreatment(name, "command", input)).toBe("head");
  });

  it("passes unknown names through untouched, divergent keys and all", () => {
    // The media/meta tools the table leaves unmapped, and MCP tools:
    // renaming keys on a tool we don't know would corrupt its modal display.
    const input = { task_ids: ["01a"], timeout_ms: 30000, target_file: "/x" };
    const result = normalizeGrokToolCall("get_command_or_subagent_output", input);
    expect(result.name).toBe("get_command_or_subagent_output");
    expect(result.input).toBe(input);
  });

  it("leaves the interactive trio raw — their card shapes are unverified", () => {
    // AskUserQuestion / ExitPlanMode render their INPUT inline and return
    // before the modal; mapping an unobserved shape onto them could blank the
    // row. A raw generic row is the visible, safe degradation.
    for (const name of ["ask_user_question", "enter_plan_mode", "exit_plan_mode"]) {
      expect(normalizeGrokToolCall(name, { q: "?" }).name).toBe(name);
    }
  });

  it("does not mutate the caller's input", () => {
    const input = { target_file: "/w/a.ts" };
    normalizeGrokToolCall("read_file", input);
    expect(input).toEqual({ target_file: "/w/a.ts" });
  });
});

describe("normalizeGrokToolResult — the subagent envelope (planning#437)", () => {
  // Verbatim result shapes from Grok CLI 1.0.1 (docs/272 captures 2026-08-18):
  // a foreground spawn completes with `SubagentCompleted` whose `output` is the
  // report; a background spawn acknowledges with a `Text` envelope.
  const COMPLETED =
    '{"type":"SubagentCompleted","output":"3","subagent_id":"01a01473-5afe-7f41-bae0-cc44fce151c8","subagent_type":"explore","tool_calls":1,"turns":1,"duration_ms":3556,"worktree_path":null,"resume_from_hint":"01a01473-5afe-7f41-bae0-cc44fce151c8"}';
  const BACKGROUND =
    '{"type":"Text","text":"Subagent started in background.\\nsubagent_id: 01a01461-17ae-70b1-a6d1-500f9866a5b6"}';

  it("unwraps a completed spawn so the persisted content IS the report", () => {
    expect(normalizeGrokToolResult("spawn_subagent", COMPLETED)).toBe("3");
  });

  it("keeps a multi-line markdown report intact", () => {
    const report = "## Findings\n\n- one\n- two";
    expect(
      normalizeGrokToolResult(
        "spawn_subagent",
        JSON.stringify({ type: "SubagentCompleted", output: report, turns: 2 }),
      ),
    ).toBe(report);
  });

  it("unwraps a background spawn's acknowledgement text", () => {
    expect(normalizeGrokToolResult("spawn_subagent", BACKGROUND)).toContain(
      "Subagent started in background.",
    );
  });

  it("passes an unrecognized shape through untouched — the safe direction for a CLI format change", () => {
    expect(normalizeGrokToolResult("spawn_subagent", "plain text")).toBe("plain text");
    expect(normalizeGrokToolResult("spawn_subagent", '{"type":"SomethingNew","body":1}')).toBe(
      '{"type":"SomethingNew","body":1}',
    );
    expect(normalizeGrokToolResult("spawn_subagent", '{"type":"SubagentCompleted","output":7}')).toBe(
      '{"type":"SubagentCompleted","output":7}',
    );
  });

  it("does not touch other tools' output, even envelope-shaped output", () => {
    expect(normalizeGrokToolResult("run_terminal_command", COMPLETED)).toBe(COMPLETED);
    expect(normalizeGrokToolResult("get_command_or_subagent_output", COMPLETED)).toBe(COMPLETED);
  });
});
