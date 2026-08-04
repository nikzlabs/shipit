import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { SubagentCall } from "./SubagentCall.js";
import type { ToolUseBlock, ToolResultBlock, SubagentEvent } from "./MessageList.js";

afterEach(cleanup);

const TASK_ID = "toolu_task_1";

function task(): ToolUseBlock {
  return {
    type: "tool_use",
    id: TASK_ID,
    name: "Agent",
    input: { description: "Count words in README.md", subagent_type: "general-purpose" },
  };
}

function reportResult(content: string, isError?: boolean): ToolResultBlock[] {
  return [{ toolUseId: TASK_ID, content, isError }];
}

function workEvents(n: number): SubagentEvent[] {
  return Array.from({ length: n }, (_, i) => ({
    kind: "assistant" as const,
    parentToolUseId: TASK_ID,
    text: "",
    toolUse: [
      { type: "tool_use" as const, id: `sub-${i}`, name: "Read", input: { file_path: `/f${i}.ts` } },
    ],
  }));
}

/**
 * The work timeline is collapsed by default, in every state. A turn with two
 * or three subagents used to bury the main transcript under their tool calls;
 * the count on the toggle is what tells the reader work is happening without
 * spending the vertical space.
 */
describe("SubagentCall work timeline", () => {
  it("stays collapsed while the subagent runs, showing a live action count", () => {
    render(<SubagentCall tool={task()} subagentEvents={workEvents(3)} isStreaming={true} />);

    expect(screen.queryByTestId("subagent-work")).not.toBeInTheDocument();
    expect(screen.getByTestId("subagent-work-toggle")).toHaveTextContent("3 actions");
    // Something is clearly going on even with the timeline hidden.
    expect(screen.getByTestId("subagent-running")).toBeInTheDocument();
  });

  it("stays collapsed after the final report arrives", () => {
    render(
      <SubagentCall
        tool={task()}
        subagentEvents={workEvents(2)}
        parentToolResults={reportResult("Done.")}
        isStreaming={false}
      />,
    );

    expect(screen.queryByTestId("subagent-work")).not.toBeInTheDocument();
    expect(screen.getByTestId("subagent-final-report")).toBeInTheDocument();
  });

  it("expands on click and collapses again — the user's toggle wins", () => {
    render(<SubagentCall tool={task()} subagentEvents={workEvents(1)} isStreaming={true} />);

    fireEvent.click(screen.getByTestId("subagent-work-toggle"));
    expect(screen.getByTestId("subagent-work")).toBeInTheDocument();
    expect(screen.getByTestId("subagent-work-toggle")).toHaveTextContent("1 action");

    fireEvent.click(screen.getByTestId("subagent-work-toggle"));
    expect(screen.queryByTestId("subagent-work")).not.toBeInTheDocument();
  });
});

/**
 * SHI-287 — the report the user reads.
 *
 * The parsing itself is covered exhaustively in
 * `utils/group-events-by-parent.test.ts`; these two assert the thing that was
 * actually broken on screen, which no unit test of the parser can show: the
 * card rendered `[{"type":"text","text":"…"}]` verbatim through the markdown
 * renderer.
 */
describe("SubagentCall final report", () => {
  it("renders the prose from the CLI's block-array shape, not the JSON", () => {
    // Verbatim from Claude Code CLI 2.1.219 on a live turn: the report block,
    // then the CLI's own accounting footer.
    const content = JSON.stringify([
      { type: "text", text: "Counted the words: 2,145 across 264 lines." },
      { type: "text", text: "agentId: af658a55f1a8b9594\nsubagent_tokens: 49171\ntool_uses: 1" },
    ]);

    render(<SubagentCall tool={task()} parentToolResults={reportResult(content)} isStreaming={false} />);

    const report = screen.getByTestId("subagent-final-report");
    expect(report).toHaveTextContent("Counted the words: 2,145 across 264 lines.");
    // The regression itself: no JSON punctuation reaches the user.
    expect(report.textContent).not.toContain('"type"');
    expect(report.textContent).not.toContain('\\n');

    // The footer is addressed to the agent, not the reader — demoted out of
    // the report body rather than deleted, so nothing is silently lost.
    expect(screen.getByTestId("subagent-report-meta")).toHaveTextContent("subagent_tokens: 49171");
  });

  it("leaves a plain-string report unchanged and shows no meta line", () => {
    render(
      <SubagentCall
        tool={task()}
        parentToolResults={reportResult("## Findings\n\nAll three checks passed.")}
        isStreaming={false}
      />,
    );

    expect(screen.getByTestId("subagent-final-report")).toHaveTextContent("All three checks passed.");
    expect(screen.queryByTestId("subagent-report-meta")).toBeNull();
  });
});
