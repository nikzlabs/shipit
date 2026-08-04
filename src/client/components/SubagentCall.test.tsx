import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { SubagentCall } from "./SubagentCall.js";
import { useSessionStore } from "../stores/session-store.js";
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

/**
 * SHI-296 — the prompt is the heaviest thing on a subagent card and it sits
 * behind a collapsed disclosure, so docs/244's projection drops it and leaves
 * only its length. These pin the two halves of that: the collapsed header must
 * look exactly as it does when the prompt arrived whole (req 8), and expanding
 * must actually produce the prompt (req 2).
 */
describe("SubagentCall lazy prompt (docs/244)", () => {
  function deferredTask(chars: number): ToolUseBlock {
    return {
      ...task(),
      // The projection removes `prompt` from `input` entirely and records what
      // it was worth in `inputChars`.
      inputChars: { prompt: chars },
    };
  }

  beforeEach(() => {
    useSessionStore.setState({ sessionId: "session-1" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useSessionStore.getState().reset();
  });

  it("labels the toggle from the recorded length, with the prompt absent", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<SubagentCall tool={deferredTask(4096)} isStreaming={false} />);

    expect(screen.getByTestId("subagent-prompt-toggle")).toHaveTextContent("Prompt (4096 chars)");
    // Collapsed: nothing has been asked for, so nothing is fetched.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches the prompt when the user expands it", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ input: { description: "d", prompt: "the whole prompt" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SubagentCall tool={deferredTask(16)} isStreaming={false} />);
    fireEvent.click(screen.getByTestId("subagent-prompt-toggle"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]![0]).toBe(`/api/sessions/session-1/tool-inputs/${TASK_ID}`);
    await waitFor(() => expect(screen.getByTestId("subagent-prompt")).toHaveTextContent("the whole prompt"));
  });

  it("says so rather than showing an empty box when the fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    render(<SubagentCall tool={deferredTask(16)} isStreaming={false} />);
    fireEvent.click(screen.getByTestId("subagent-prompt-toggle"));

    await waitFor(() => expect(screen.getByTestId("subagent-prompt")).toHaveTextContent("Couldn't load this prompt"));
  });

  it("does not fetch for a prompt that arrived whole", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const tool = { ...task(), input: { ...task().input, prompt: "short prompt" } };
    render(<SubagentCall tool={tool} isStreaming={false} />);
    fireEvent.click(screen.getByTestId("subagent-prompt-toggle"));

    expect(screen.getByTestId("subagent-prompt")).toHaveTextContent("short prompt");
    expect(screen.getByTestId("subagent-prompt-toggle")).toHaveTextContent("Prompt (12 chars)");
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
  });
});
