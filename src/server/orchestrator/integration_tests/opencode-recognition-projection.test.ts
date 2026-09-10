import { describe, it, expect } from "vitest";
import { projectToolUse } from "../transcript-projection.js";
import { normalizeOpencodeToolCall } from "../../session/agents/opencode/opencode-tool-normalizer.js";

describe("OpenCode edit/write recognition through the wire projection", () => {
  // Exceed INPUT_STRIP_FLOOR_BYTES to exercise body stripping.
  const bigOld = Array.from({ length: 20 }, (_, i) => `old line ${i}`).join("\n");
  const bigNew = Array.from({ length: 30 }, (_, i) => `new line ${i}`).join("\n");

  it("a normalized edit gets diffStats and keeps file_path when its body is stripped", () => {
    const call = normalizeOpencodeToolCall("edit", {
      filePath: "/workspace/a.ts",
      oldString: bigOld,
      newString: bigNew,
    });
    const projected = projectToolUse({ id: "call_1", ...call });
    expect(projected.diffStats).toEqual({ added: 30, removed: 20 });
    expect(projected.input.file_path).toBe("/workspace/a.ts");
    expect(projected.bodyTruncated).toBe(true);
    expect(projected.input.old_string).toBeUndefined();
    expect(projected.input.new_string).toBeUndefined();
  });

  it("a normalized write gets diffStats from its content when its body is stripped", () => {
    const call = normalizeOpencodeToolCall("write", {
      filePath: "/workspace/probe-note.md",
      content: `${bigNew}\n`,
    });
    const projected = projectToolUse({ id: "call_2", ...call });
    expect(projected.diffStats).toEqual({ added: 30, removed: 0 });
    expect(projected.input.file_path).toBe("/workspace/probe-note.md");
  });

  it("a small edit keeps its snake_case body keys on the wire, which DiffBlock recomputes from", () => {
    const call = normalizeOpencodeToolCall("edit", {
      filePath: "/workspace/a.ts",
      oldString: "one\n",
      newString: "two\n",
    });
    const projected = projectToolUse({ id: "call_3", ...call });
    expect(projected.input).toEqual({ file_path: "/workspace/a.ts", old_string: "one\n", new_string: "two\n" });
  });

  it("negative control: a normalized bash gets no diffStats", () => {
    const call = normalizeOpencodeToolCall("bash", { command: "echo conversion-probe" });
    const projected = projectToolUse({ id: "call_4", ...call });
    expect(projected.diffStats).toBeUndefined();
  });

  it("a normalized todowrite keeps its whole todos array on the wire", () => {
    const call = normalizeOpencodeToolCall("todowrite", {
      todos: [
        { content: "first", status: "completed" },
        { content: "second", status: "in_progress" },
      ],
    });
    const projected = projectToolUse({ id: "call_3", ...call });
    expect(projected.input.todos).toEqual(call.input.todos);
    expect(projected.bodyTruncated).toBeUndefined();
  });
});
