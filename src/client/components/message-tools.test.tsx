import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ToolUseItem, formatToolDuration } from "./message-tools.js";
import type { ToolUseBlock } from "./MessageList.js";

afterEach(() => {
  cleanup();
});

function tool(name: string, input: Record<string, unknown>): ToolUseBlock {
  return { id: "t1", name, input } as ToolUseBlock;
}

describe("ToolUseItem apply_patch", () => {
  it("renders a diff block per changed file with line stats and kind verbs", () => {
    render(
      <ToolUseItem
        tool={tool("apply_patch", {
          files: ["/workspace/src/game/Game.js", "/workspace/src/new.js"],
          changes: [
            { path: "/workspace/src/game/Game.js", kind: "update", diff: "@@ -1 +1 @@\n-a\n+b" },
            { path: "/workspace/src/new.js", kind: "add", diff: "+x\n+y" },
          ],
        })}
        isLast={false}
        isStreaming={false}
        isQuestionDisabled
      />,
    );

    // Paths render (workspace prefix stripped), kind mapped to Claude verbs.
    expect(screen.getByText("src/game/Game.js")).toBeInTheDocument();
    expect(screen.getByText("src/new.js")).toBeInTheDocument();
    expect(screen.getByText("Edit")).toBeInTheDocument();
    expect(screen.getByText("Write")).toBeInTheDocument();
    // Line stats from the unified diff (update: +1/-1, add: +2).
    expect(screen.getByText("+1")).toBeInTheDocument();
    expect(screen.getByText("-1")).toBeInTheDocument();
    expect(screen.getByText("+2")).toBeInTheDocument();
    // Never the stringified-object artifact the bug produced.
    expect(screen.queryByText(/\[object Object\]/)).toBeNull();
  });

  it("opens the full diff on click", () => {
    render(
      <ToolUseItem
        tool={tool("apply_patch", {
          changes: [{ path: "/workspace/a.ts", kind: "update", diff: "@@ -1 +1 @@\n-old\n+new" }],
        })}
        isLast={false}
        isStreaming={false}
        isQuestionDisabled
      />,
    );
    fireEvent.click(screen.getByLabelText("Show diff"));
    expect(screen.getByText("+new")).toBeInTheDocument();
    expect(screen.getByText("-old")).toBeInTheDocument();
  });
});

describe("ToolUseItem output modal input", () => {
  it("shows the agent's input fields, not just the output", () => {
    render(
      <ToolUseItem
        tool={tool("Read", {
          file_path: "/workspace/src/foo.ts",
          offset: 10,
          limit: 50,
        })}
        result={{ toolUseId: "t1", content: "file content here" }}
        isLast={false}
        isStreaming={false}
        isQuestionDisabled
      />,
    );

    fireEvent.click(screen.getByLabelText("Show output"));

    // Field labels for the raw input keys are rendered in the modal.
    expect(screen.getByText("file_path")).toBeInTheDocument();
    expect(screen.getByText("offset")).toBeInTheDocument();
    expect(screen.getByText("limit")).toBeInTheDocument();
    // Non-string args that used to be dropped are now shown.
    expect(screen.getByText("10")).toBeInTheDocument();
    expect(screen.getByText("50")).toBeInTheDocument();
    // file_path is shown workspace-relative (one-liner + modal field).
    expect(screen.getAllByText("src/foo.ts").length).toBeGreaterThan(0);
    // The output section still renders below the input.
    expect(screen.getByText("Output")).toBeInTheDocument();
  });

  it("shows the derived tool duration next to Output when present (docs/185)", () => {
    render(
      <ToolUseItem
        tool={tool("Bash", { command: "ls" })}
        result={{ toolUseId: "t1", content: "out", durationMs: 1234 }}
        isLast={false}
        isStreaming={false}
        isQuestionDisabled
      />,
    );
    fireEvent.click(screen.getByLabelText("Show output"));
    expect(screen.getByText("1.2 s")).toBeInTheDocument();
  });

  it("omits the duration when the result has none", () => {
    render(
      <ToolUseItem
        tool={tool("Bash", { command: "ls" })}
        result={{ toolUseId: "t1", content: "out" }}
        isLast={false}
        isStreaming={false}
        isQuestionDisabled
      />,
    );
    fireEvent.click(screen.getByLabelText("Show output"));
    expect(screen.queryByText(/\d+\s?(ms|s)$/)).not.toBeInTheDocument();
  });
});

describe("formatToolDuration (docs/185)", () => {
  it("renders sub-second values in whole milliseconds", () => {
    expect(formatToolDuration(0)).toBe("0 ms");
    expect(formatToolDuration(450)).toBe("450 ms");
    expect(formatToolDuration(999)).toBe("999 ms");
  });
  it("renders under-10s values with one decimal", () => {
    expect(formatToolDuration(1234)).toBe("1.2 s");
    expect(formatToolDuration(9990)).toBe("10.0 s");
  });
  it("renders longer values as whole seconds", () => {
    expect(formatToolDuration(12000)).toBe("12 s");
    expect(formatToolDuration(65432)).toBe("65 s");
  });
  it("returns empty string for invalid input", () => {
    expect(formatToolDuration(-5)).toBe("");
    expect(formatToolDuration(NaN)).toBe("");
  });
});
