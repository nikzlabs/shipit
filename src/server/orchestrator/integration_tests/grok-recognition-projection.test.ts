/**
 * planning#437 — the diff half of the Grok recognition guards.
 *
 * The rest of the surface-treatment guards live next to the normalizer
 * (`session/agents/grok/grok-tool-normalizer.test.ts`); this one needs
 * `projectToolUse` / `DIFF_INPUT_TOOLS`, which are orchestrator-side, and the
 * layer-boundary lint allows the crossing only here. It pins the contract that
 * failed in the docs/272 RED run: a Grok search_replace/write, normalized, must
 * come out of the wire projection with `diffStats` — the artifact the DiffBlock
 * renders — and with its `file_path` still on the wire.
 */

import { describe, it, expect } from "vitest";
import { projectToolUse } from "../transcript-projection.js";
import { normalizeGrokToolCall } from "../../session/agents/grok/grok-tool-normalizer.js";

describe("Grok search_replace/write recognition through the wire projection", () => {
  // Bodies above INPUT_STRIP_FLOOR_BYTES (200), so the projection strips them —
  // the path where diffStats is the ONLY surviving diff information.
  const bigOld = Array.from({ length: 20 }, (_, i) => `old line ${i}`).join("\n");
  const bigNew = Array.from({ length: 30 }, (_, i) => `new line ${i}`).join("\n");

  it("a normalized search_replace gets diffStats and keeps file_path when its body is stripped", () => {
    const call = normalizeGrokToolCall("search_replace", {
      file_path: "/workspace/a.ts",
      old_string: bigOld,
      new_string: bigNew,
    });
    const projected = projectToolUse({ id: "call_1", ...call });
    expect(projected.diffStats).toEqual({ added: 30, removed: 20 });
    expect(projected.input.file_path).toBe("/workspace/a.ts");
    // The body keys are dropped from the wire (modal-fetchable), which is only
    // safe BECAUSE diffStats was computed first.
    expect(projected.bodyTruncated).toBe(true);
    expect(projected.input.old_string).toBeUndefined();
    expect(projected.input.new_string).toBeUndefined();
  });

  it("a normalized write gets diffStats from its content when its body is stripped", () => {
    const call = normalizeGrokToolCall("write", {
      file_path: "/workspace/probe-note.md",
      content: `${bigNew}\n`,
    });
    const projected = projectToolUse({ id: "call_2", ...call });
    expect(projected.diffStats).toEqual({ added: 30, removed: 0 });
    expect(projected.input.file_path).toBe("/workspace/probe-note.md");
  });

  it("negative control: a normalized run_terminal_command gets no diffStats", () => {
    const call = normalizeGrokToolCall("run_terminal_command", { command: "echo conversion-probe" });
    const projected = projectToolUse({ id: "call_3", ...call });
    expect(projected.diffStats).toBeUndefined();
  });

  it("a normalized todo_write keeps todos, merge and item ids on the wire — the fold patches by them", () => {
    const call = normalizeGrokToolCall("todo_write", {
      todos: [
        { id: "1", content: "Read package.json and create/edit probe-note.md", status: "completed" },
        { id: "2", content: "Run echo conversion-probe and search the repo for it", status: "in_progress" },
        { id: "3", content: "Spawn a subagent to count files in the repo root", status: "pending" },
      ],
      merge: false,
    });
    const projected = projectToolUse({ id: "call_4", ...call });
    expect(projected.input.todos).toEqual(call.input.todos);
    expect(projected.input.merge).toBe(false);
    expect(projected.bodyTruncated).toBeUndefined();
  });
});
