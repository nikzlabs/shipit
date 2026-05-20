import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ToolUseItem } from "./message-tools.js";
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
