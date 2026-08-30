import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { ToolUseItem, formatToolDuration } from "./message-tools.js";
import { useSessionStore } from "../stores/session-store.js";
import type { ToolUseBlock } from "./MessageList.js";
import { highlightCode } from "../syntax-highlight.js";

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
    // Kind verbs render as icons labeled with the verb (update → Edit, add → Write).
    expect(screen.getByLabelText("Edit")).toBeInTheDocument();
    expect(screen.getByLabelText("Write")).toBeInTheDocument();
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

describe("ToolUseItem inline tool icon", () => {
  it("renders the tool as a glyph + short verb, plus its argument", () => {
    render(
      <ToolUseItem
        tool={tool("Read", { file_path: "/workspace/src/foo.ts" })}
        isLast={false}
        isStreaming={false}
        isQuestionDisabled
      />,
    );
    // The verb is shown as visible text (not hover-only) next to the glyph…
    expect(screen.getByText("Read")).toBeInTheDocument();
    // …followed by the argument summary (file path).
    expect(screen.getByText("src/foo.ts")).toBeInTheDocument();
  });

  it("shows no icon for shell/Bash — just the command, flush", () => {
    render(
      <ToolUseItem
        tool={tool("shell", { command: "ls -la" })}
        isLast={false}
        isStreaming={false}
        isQuestionDisabled
      />,
    );
    // No tool word at all (no icon, no "shell"); the command stands in for the tool.
    expect(screen.queryByText("shell")).toBeNull();
    expect(screen.getByText("ls -la")).toBeInTheDocument();
  });

  it("falls back to text for tools without a mapped icon", () => {
    render(
      <ToolUseItem
        tool={tool("SomeUnknownTool", {})}
        isLast={false}
        isStreaming={false}
        isQuestionDisabled
      />,
    );
    expect(screen.getByText("SomeUnknownTool")).toBeInTheDocument();
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

describe("ToolUseItem pending tool calls", () => {
  it("is clickable while pending and shows input + a running indicator (no result yet)", () => {
    render(
      <ToolUseItem
        tool={tool("Bash", { command: "sleep 5" })}
        // No result — the tool is the last one in a still-streaming message.
        isLast
        isStreaming
        isQuestionDisabled
      />,
    );

    // Pending tools expose a "Show input" affordance (vs "Show output" once done).
    fireEvent.click(screen.getByLabelText("Show input"));

    // Input is shown.
    expect(screen.getByText("command")).toBeInTheDocument();
    // Output section renders a running indicator instead of a tool result.
    expect(screen.getByText("Output")).toBeInTheDocument();
    expect(screen.getByText("Running…")).toBeInTheDocument();
  });

  it("updates the open dialog in place when the result arrives", () => {
    const t = tool("Bash", { command: "run-job" });
    const { rerender } = render(
      <ToolUseItem tool={t} isLast isStreaming isQuestionDisabled />,
    );

    // Open the dialog while pending.
    fireEvent.click(screen.getByLabelText("Show input"));
    expect(screen.getByText("Running…")).toBeInTheDocument();

    // Result arrives — same component instance (stable position) re-renders with it.
    rerender(
      <ToolUseItem
        tool={t}
        result={{ toolUseId: "t1", content: "job complete", durationMs: 1234 }}
        isLast={false}
        isStreaming={false}
        isQuestionDisabled
      />,
    );

    // The running indicator is replaced in place by the output, no re-click needed.
    expect(screen.queryByText("Running…")).toBeNull();
    expect(screen.getByText("1.2 s")).toBeInTheDocument();
    expect(screen.getByText("job complete")).toBeInTheDocument();
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

/**
 * planning#298 — the tool-call modal is the only view that draws a tool's whole
 * input, so it is where the keys docs/244's projection removed come back.
 * Opening the modal is the click requirement 8 licenses a loading state for.
 *
 * The transcript line itself must be unchanged, which is the first test: the
 * server ships exactly the characters the line slices to, so a truncated
 * `command` and a whole one render identically above the fold.
 */
describe("ToolUseItem lazy tool input (docs/244)", () => {
  beforeEach(() => {
    useSessionStore.setState({ sessionId: "session-1" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useSessionStore.getState().reset();
  });

  function truncatedBash(): ToolUseBlock {
    return {
      ...tool("Bash", { command: "echo one" }),
      bodyTruncated: true,
      inputChars: { command: 4096, description: 900 },
    } as ToolUseBlock;
  }

  it("draws the transcript line from the shipped prefix, with no fetch", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ToolUseItem
        tool={truncatedBash()}
        result={{ toolUseId: "t1", content: "out" }}
        isLast={false}
        isStreaming={false}
        isQuestionDisabled
      />,
    );

    expect(screen.getByText("echo one")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches the whole input when the modal opens and renders the recovered keys", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ input: { command: "echo one two three", description: "say hello" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ToolUseItem
        tool={truncatedBash()}
        result={{ toolUseId: "t1", content: "out" }}
        isLast={false}
        isStreaming={false}
        isQuestionDisabled
      />,
    );
    fireEvent.click(screen.getByLabelText("Show output"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/sessions/session-1/tool-inputs/t1");
    // `description` was dropped on the wire entirely — its field only exists
    // because the fetch brought it back.
    await waitFor(() => expect(screen.getByText("description")).toBeInTheDocument());
    expect(screen.getByLabelText("Tool output")).toHaveTextContent("echo one two three");
  });

  it("keeps the fields it has and says more is coming, rather than blanking", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));

    render(
      <ToolUseItem
        tool={truncatedBash()}
        result={{ toolUseId: "t1", content: "out" }}
        isLast={false}
        isStreaming={false}
        isQuestionDisabled
      />,
    );
    fireEvent.click(screen.getByLabelText("Show output"));

    await waitFor(() => expect(screen.getByText("Loading input…")).toBeInTheDocument());
    // The prefix already on the wire is still shown while the rest is in flight.
    expect(screen.getByLabelText("Tool output")).toHaveTextContent("echo one");
  });

  it("surfaces a failed fetch instead of silently showing a partial input", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    render(
      <ToolUseItem
        tool={truncatedBash()}
        result={{ toolUseId: "t1", content: "out" }}
        isLast={false}
        isStreaming={false}
        isQuestionDisabled
      />,
    );
    fireEvent.click(screen.getByLabelText("Show output"));

    await waitFor(() => expect(screen.getByLabelText("Tool output")).toHaveTextContent("load the full input"));
  });

  it("does not fetch for an input that arrived whole", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

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

    await waitFor(() => expect(screen.getByText("command")).toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * The modal draws the tool's input directly above its output, so for a `Read`
 * it is holding the very `file_path` the output panel would otherwise have to
 * guess at. Auto-detection re-highlights the body once per registered grammar
 * — a production trace measured ~274 ms per call, synchronously in a render —
 * so this wiring is the point of the change, not a convenience.
 */
describe("ToolUseItem read-output highlighting", () => {
  /**
   * highlight.js escapes `"` as `&quot;`; the DOM serializes it back to a bare
   * quote. Round-trip the expectation so both sides match on markup.
   */
  function asRendered(html: string | null): string | null {
    if (html === null) return null;
    const el = document.createElement("code");
    el.innerHTML = html;
    return el.innerHTML;
  }

  // Ambiguous on purpose: JSON object vs Python dict literal highlight
  // differently, so the assertion can tell "used the path" from "guessed".
  const content = '{"a": 1, "b": [2, 3]}';

  it("highlights a Read result as the language of the file_path it was given", () => {
    render(
      <ToolUseItem
        tool={tool("Read", { file_path: "/workspace/config.py" })}
        result={{ toolUseId: "t1", content }}
        isLast={false}
        isStreaming={false}
        isQuestionDisabled
      />,
    );
    fireEvent.click(screen.getByLabelText("Show output"));

    const code = screen.getByLabelText("Tool output").querySelector("code.hljs");
    expect(code?.innerHTML).toBe(asRendered(highlightCode(content, "python")));
    expect(code?.innerHTML).not.toBe(asRendered(highlightCode(content, null)));
  });

  it("falls back to auto-detection when the tool input names no file", () => {
    render(
      <ToolUseItem
        tool={tool("Read", {})}
        result={{ toolUseId: "t1", content }}
        isLast={false}
        isStreaming={false}
        isQuestionDisabled
      />,
    );
    fireEvent.click(screen.getByLabelText("Show output"));

    const code = screen.getByLabelText("Tool output").querySelector("code.hljs");
    expect(code?.innerHTML).toBe(asRendered(highlightCode(content, null)));
  });
});
