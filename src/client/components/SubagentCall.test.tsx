import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { SubagentCall } from "./SubagentCall.js";
// Deliberate client→session coupling (test-only): the alternative is a
// hand-kept copy of the normalizer's output, the planning#337 anti-pattern. No
// lint boundary blocks this today; the module is dependency-free pure TS.
import { normalizeOpencodeToolResult } from "../../server/session/agents/opencode/opencode-tool-normalizer.js";
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
 * planning#289 — the report the user reads.
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

    // req 5 — the footer is addressed to the agent, not the reader. It is
    // demoted to header chips rather than printed as raw `key: value` text.
    const meta = screen.getByTestId("subagent-report-meta");
    expect(meta).toHaveTextContent("49.2k tokens");
    expect(meta).toHaveTextContent("1 tool");
    // The internal handle must never reach the DOM (req 5).
    expect(report.textContent).not.toContain("af658a55f1a8b9594");
    expect(meta.textContent).not.toContain("agentId");
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
 * planning#434 — the OpenCode report, raw wire to DOM.
 *
 * OpenCode's `task` result arrives wrapped in `<task …><task_result>…</…>`
 * tags. In CommonMark the `<task …>` line opens an HTML block that runs to the
 * next blank line, and the report renderer passes `skipHtml` — so the whole
 * wrapper, report text included, was dropped and the panel rendered visually
 * empty while the persisted content was whole (the two surfaces disagree
 * exactly when a renderer swallows content, which is how the first
 * verification run recorded this as passing). The fix unwraps at the adapter
 * boundary; this test runs the REAL raw capture through the real normalizer
 * into the real card, so removing the unwrap goes red here at the DOM level.
 */
describe("SubagentCall OpenCode report (planning#434)", () => {
  // Verbatim result shape from OpenCode CLI 1.18.15 (docs/272 run 2026-08-18).
  const RAW_WIRE =
    '<task id="ses_8f214c2af" state="completed">\n<task_result>\n11\n</task_result>\n</task>';

  it("renders the report text once the adapter has unwrapped the task wrapper", () => {
    const content = normalizeOpencodeToolResult("task", RAW_WIRE);

    render(<SubagentCall tool={task()} parentToolResults={reportResult(content)} isStreaming={false} />);

    expect(screen.getByTestId("subagent-final-report")).toHaveTextContent("11");
  });

  it("the raw wrapper renders EMPTY — the mechanism that makes the unwrap load-bearing", () => {
    // If this ever fails because the wrapper's inner text became visible, the
    // markdown renderer stopped swallowing HTML blocks and the unwrap may no
    // longer be the only thing keeping the report on screen — re-evaluate
    // planning#434 before "fixing" this assertion.
    render(<SubagentCall tool={task()} parentToolResults={reportResult(RAW_WIRE)} isStreaming={false} />);

    expect(screen.getByTestId("subagent-final-report").textContent).not.toContain("11");
  });
});

/**
 * docs/109 req 1/2 — the case from the bug report. A `run_in_background` Task
 * returns the CLI's launch acknowledgement, which is machinery addressed to the
 * agent ("never quote or paste any part of it"). The card printed it verbatim
 * under FINAL REPORT and stamped the header `done` for a subagent that was
 * still running.
 */
describe("SubagentCall backgrounded subagent", () => {
  // Verbatim from Claude Code CLI on a live turn, trimmed to the two lines that
  // carry the shape.
  const ACK = [
    "Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)",
    "agentId: a90130de265682eb8 (internal ID - do not mention to user.)",
    "output_file: /tmp/claude-1000/-workspace/637e/tasks/a90130de265682eb8.output",
  ].join("\n");

  it("shows a running row instead of a report, and none of the metadata", () => {
    render(<SubagentCall tool={task()} parentToolResults={reportResult(ACK)} isStreaming={false} />);

    expect(screen.queryByTestId("subagent-final-report")).toBeNull();
    const note = screen.getByTestId("subagent-background-note");
    expect(note).toHaveTextContent("Running in the background");
    expect(document.body.textContent).not.toContain("a90130de265682eb8");
    expect(document.body.textContent).not.toContain("output_file");
  });

  it("says in background rather than done — the subagent has not finished", () => {
    render(<SubagentCall tool={task()} parentToolResults={reportResult(ACK)} isStreaming={false} />);

    expect(screen.getByTestId("subagent-background")).toHaveTextContent("in background");
    expect(screen.queryByTestId("subagent-done")).toBeNull();
  });

  /**
   * The guard on the recognizer's narrowness. This repo's own docs quote the
   * acknowledgement's opening sentence, so a subagent reporting on them would
   * have its real report swallowed if the phrase alone were the test.
   */
  it("does not swallow a real report that merely quotes the phrase", () => {
    const content = "The CLI returns \"Async agent launched successfully\" for a backgrounded Task.";
    render(<SubagentCall tool={task()} parentToolResults={reportResult(content)} isStreaming={false} />);

    expect(screen.getByTestId("subagent-final-report")).toHaveTextContent("backgrounded Task");
    expect(screen.queryByTestId("subagent-background-note")).toBeNull();
  });
});

/**
 * docs/109 reqs 6–8 — a long report clamps inline and opens in a modal, and the
 * transcript carries only the clamped head (`truncated`), so the modal fetches
 * the rest.
 */
describe("SubagentCall long report", () => {
  const LONG = Array.from({ length: 40 }, (_, i) => `Finding ${i}: something worth saying.`).join("\n");

  /**
   * jsdom has no layout, so every element reports `scrollHeight === 0` and the
   * component's `ResizeObserver` measurement would never see an overflow. Stub
   * it with a proxy for height — text length against a fixed budget — so the
   * clamp's real branch is exercised rather than asserted around.
   */
  function stubLayout() {
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement) { return this.textContent?.length ?? 0; },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 200 });
  }

  beforeEach(() => {
    useSessionStore.setState({ sessionId: "session-1" });
    stubLayout();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
    Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
    useSessionStore.getState().reset();
  });

  it("offers the modal for a long report and nothing for a short one", () => {
    const { unmount } = render(
      <SubagentCall tool={task()} parentToolResults={reportResult(LONG)} isStreaming={false} />,
    );
    expect(screen.getByTestId("subagent-report-expand")).toHaveTextContent("Show the full report");
    unmount();

    render(<SubagentCall tool={task()} parentToolResults={reportResult("Done.")} isStreaming={false} />);
    expect(screen.queryByTestId("subagent-report-expand")).toBeNull();
  });

  it("fetches the rest when the modal opens, and not before", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: `${LONG}\nFinding 40: the tail the transcript never carried.` }),
    });
    vi.stubGlobal("fetch", fetchMock);

    // What the serve path produces: the clamped head plus the markers.
    const sliced: ToolResultBlock[] = [
      { toolUseId: TASK_ID, content: LONG.split("\n").slice(0, 12).join("\n"), truncated: true, totalLines: 41 },
    ];
    render(<SubagentCall tool={task()} parentToolResults={sliced} isStreaming={false} />);

    expect(screen.getByTestId("subagent-report-expand")).toHaveTextContent("41 lines");
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("subagent-report-expand"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]![0]).toBe(`/api/sessions/session-1/tool-results/${TASK_ID}`);
    await waitFor(() =>
      expect(screen.getByTestId("subagent-report-modal-body")).toHaveTextContent("the tail the transcript never carried"),
    );
  });

  it("shows the clamped head it already has while the fetch is in flight", () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

    const sliced: ToolResultBlock[] = [
      { toolUseId: TASK_ID, content: "Finding 0: something worth saying.", truncated: true, totalLines: 41 },
    ];
    render(<SubagentCall tool={task()} parentToolResults={sliced} isStreaming={false} />);
    fireEvent.click(screen.getByTestId("subagent-report-expand"));

    // Not a blank modal: the head IS the head of what is being fetched.
    expect(screen.getByTestId("subagent-report-modal-body")).toHaveTextContent("Finding 0");
  });

  it("says so when the rest can't be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    const sliced: ToolResultBlock[] = [
      { toolUseId: TASK_ID, content: "Finding 0: something worth saying.", truncated: true, totalLines: 41 },
    ];
    render(<SubagentCall tool={task()} parentToolResults={sliced} isStreaming={false} />);
    fireEvent.click(screen.getByTestId("subagent-report-expand"));

    await waitFor(() =>
      expect(screen.getByTestId("subagent-report-modal-body")).toHaveTextContent("Couldn't load the rest"),
    );
  });

  it("does not fetch for a long report that arrived whole", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<SubagentCall tool={task()} parentToolResults={reportResult(LONG)} isStreaming={false} />);
    fireEvent.click(screen.getByTestId("subagent-report-expand"));

    expect(screen.getByTestId("subagent-report-modal-body")).toHaveTextContent("Finding 39");
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
  });
});

/**
 * planning#298 — the prompt is the heaviest thing on a subagent card and it sits
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
