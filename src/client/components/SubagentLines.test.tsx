import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { SubagentLines } from "./SubagentLines.js";
import { normalizeOpencodeToolResult } from "../../server/session/agents/opencode/opencode-tool-normalizer.js";
import { useSessionStore } from "../stores/session-store.js";
import type { ChatMessage, ToolResultBlock, ToolUseBlock } from "./MessageList.js";
import type { SubAgentConsultCard } from "../../server/shared/types.js";

const TASK_ID = "toolu_task_1";

const ACK = [
  "Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)",
  "agentId: a90130de265682eb8 (internal ID - do not mention to user.)",
  "output_file: /tmp/claude-1000/-workspace/637e/tasks/a90130de265682eb8.output",
].join("\n");

function task(over: Partial<ToolUseBlock> = {}, id = TASK_ID): ToolUseBlock {
  return {
    type: "tool_use",
    id,
    name: "Agent",
    input: { description: "Count words in README.md", subagent_type: "general-purpose", prompt: "Count the words." },
    ...over,
  };
}

function launch(tool: ToolUseBlock, results?: ToolResultBlock[], extra: Partial<ChatMessage> = {}): ChatMessage {
  return { role: "assistant", text: "", toolUse: [tool], ...(results ? { toolResults: results } : {}), ...extra };
}

function card(over: Partial<SubAgentConsultCard> = {}): SubAgentConsultCard {
  return {
    cardId: "sac-1",
    spawnId: "spawn-1",
    subAgentId: "codex",
    status: "success",
    durationMs: 47000,
    costUsd: 0.42,
    createdAt: "2026-11-05T10:00:00.000Z",
    ...over,
  };
}

/** `agentBusy` puts every row in the turn that is still running, as the live stream marks them. */
function show(messages: ChatMessage[], { agentBusy = false } = {}) {
  const rows = agentBusy ? messages.map((m) => ({ ...m, streaming: true })) : messages;
  useSessionStore.setState({
    sessionId: "session-1",
    messages: [{ role: "user", text: "go" }, ...rows],
    isLoading: agentBusy,
    activeRunnerSessions: new Set(agentBusy ? ["session-1"] : []),
  });
  return render(<SubagentLines />);
}

function openLine(name: string) {
  const find = () => screen.queryAllByTestId("subagent-line").find((l) => l.textContent?.includes(name));
  if (!find() && screen.queryByTestId("subagent-done-list") === null) {
    fireEvent.click(screen.getByTestId("subagent-done-toggle"));
  }
  const line = find();
  if (!line) throw new Error(`no line for ${name}`);
  fireEvent.click(line);
  return screen.getByTestId("subagent-dialog");
}

beforeEach(() => {
  useSessionStore.getState().reset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useSessionStore.getState().reset();
});

describe("SubagentLines — the lines (docs/339 reqs 4–7)", () => {
  it("draws nothing until a sub-agent has run", () => {
    show([{ role: "assistant", text: "hello" }]);
    expect(screen.queryByTestId("subagent-lines")).toBeNull();
  });

  it("gives each running sub-agent a line of its own, with no label", () => {
    show([launch(task()), launch(task({}, "t2")), { role: "assistant", text: "", subAgentConsult: card({ status: "pending" }) }], { agentBusy: true });
    const lines = screen.getAllByTestId("subagent-line");
    expect(lines).toHaveLength(3);
    expect(lines.every((l) => l.dataset.status === "running")).toBe(true);
    expect(screen.getByTestId("subagent-lines").textContent).not.toMatch(/Agents/);
    expect(screen.queryByTestId("subagent-done-toggle")).toBeNull();
  });

  it("counts a launch whose turn ended as stopped while only background work keeps the session busy", () => {
    useSessionStore.setState({
      sessionId: "session-1",
      messages: [{ role: "user", text: "go" }, launch(task())],
      isLoading: true,
      activeRunnerSessions: new Set(),
      backgroundTaskSessions: new Map([["session-1", ["npm test"]]]),
    });
    render(<SubagentLines />);
    expect(screen.queryAllByTestId("subagent-line")).toHaveLength(0);
    expect(screen.getByTestId("subagent-done-toggle")).toHaveTextContent("Finished subagents · 1");
  });

  it("folds finished ones into Finished subagents · N, counting no failures, and opens it in place (req 11)", () => {
    show([
      launch(task(), [{ toolUseId: TASK_ID, content: "Report." }]),
      { role: "assistant", text: "", subAgentConsult: card({ status: "error" }) },
      launch(task({}, "t2")),
    ], { agentBusy: true });

    expect(screen.getAllByTestId("subagent-line")).toHaveLength(1);
    const toggle = screen.getByTestId("subagent-done-toggle");
    expect(toggle).toHaveTextContent("Finished subagents · 2");
    expect(toggle).toHaveTextContent(/^Finished subagents · 2$/);
    expect(screen.queryByTestId("subagent-done-list")).toBeNull();

    fireEvent.click(toggle);
    const list = screen.getByTestId("subagent-done-list");
    const names = within(list).getAllByTestId("subagent-line").map((l) => l.dataset.status);
    expect(names).toEqual(["failed", "done"]);
  });
});

describe("SubagentLines — Agent-tool dialog (req 9)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("opens on the report when there is one, rendering the CLI's block-array shape as prose", () => {
    const content = JSON.stringify([
      { type: "text", text: "README has 2145 words." },
      { type: "text", text: "agentId: af658a55f1a8b9594\nsubagent_tokens: 49171\ntool_uses: 1\nduration_ms: 5411" },
    ]);
    show([launch(task(), [{ toolUseId: TASK_ID, content }])]);
    const dialog = openLine("Count words");

    expect(within(dialog).getByTestId("subagent-final-report")).toHaveTextContent("README has 2145 words.");
    expect(dialog.textContent).not.toContain("af658a55f1a8b9594");
    expect(within(dialog).getByTestId("subagent-report-meta")).toHaveTextContent("1 tool");
  });

  it("opens on the work while it runs, listing every step", () => {
    show([launch(task(), undefined, {
      subagentEvents: [{
        kind: "assistant", parentToolUseId: TASK_ID, text: "",
        toolUse: [{ type: "tool_use", id: "sub-1", name: "Read", input: { file_path: "/f1.ts" } }],
      }],
    })], { agentBusy: true });
    const dialog = openLine("Count words");

    expect(within(dialog).getByTestId("subagent-tab-work")).toHaveTextContent("Work · 1");
    expect(within(dialog).getByTestId("subagent-work")).toHaveTextContent("f1.ts");
  });

  it("renders an OpenCode report once the adapter unwrapped it (planning#434)", () => {
    const raw = '<task id="ses_8f214c2af" state="completed">\n<task_result>\n11\n</task_result>\n</task>';
    show([launch(task(), [{ toolUseId: TASK_ID, content: normalizeOpencodeToolResult("task", raw) }])]);
    expect(within(openLine("Count words")).getByTestId("subagent-final-report")).toHaveTextContent("11");
  });

  it("shows a background sub-agent as running, with none of the launch metadata (docs/109 reqs 1–2)", () => {
    show([launch(task(), [{ toolUseId: TASK_ID, content: ACK }])]);
    expect(screen.getByTestId("subagent-line").dataset.status).toBe("running");
    const dialog = openLine("Count words");
    fireEvent.mouseDown(within(dialog).getByTestId("subagent-tab-report"));

    expect(within(dialog).getByTestId("subagent-background-note")).toHaveTextContent("Running in the background");
    expect(document.body.textContent).not.toContain("a90130de265682eb8");
  });

  it("does not take a real report that quotes the phrase for a launch acknowledgement", () => {
    const content = "The CLI returns \"Async agent launched successfully\" for a backgrounded Task.";
    show([launch(task(), [{ toolUseId: TASK_ID, content }])]);
    expect(within(openLine("Count words")).getByTestId("subagent-final-report")).toHaveTextContent("backgrounded Task");
  });

  it("fetches the rest of a clamped report, and says so when it cannot (docs/109 req 8)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ content: "Head.\nThe tail the transcript never carried." }) });
    vi.stubGlobal("fetch", fetchMock);
    show([launch(task(), [{ toolUseId: TASK_ID, content: "Head.", truncated: true, totalLines: 41 }])]);
    const dialog = openLine("Count words");

    await waitFor(() => expect(within(dialog).getByTestId("subagent-report-body")).toHaveTextContent("The tail the transcript never carried."));
    expect(fetchMock.mock.calls[0]![0]).toBe(`/api/sessions/session-1/tool-results/${TASK_ID}`);
  });

  it("says so when the rest of a report can't be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    show([launch(task(), [{ toolUseId: TASK_ID, content: "Head.", truncated: true }])]);
    const dialog = openLine("Count words");
    await waitFor(() => expect(within(dialog).getByTestId("subagent-report-body")).toHaveTextContent("Couldn't load the rest"));
  });

  it("does not fetch a report that arrived whole", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    show([launch(task(), [{ toolUseId: TASK_ID, content: "Whole." }])]);
    openLine("Count words");
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
  });

  it("fetches a prompt the transcript left out when its tab opens (docs/244)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ input: { prompt: "the whole prompt" } }) });
    vi.stubGlobal("fetch", fetchMock);
    show([launch(task({ input: { description: "Count words", subagent_type: "Explore" }, inputChars: { prompt: 4096 } }))], { agentBusy: true });
    const dialog = openLine("Count words");
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.mouseDown(within(dialog).getByTestId("subagent-tab-prompt"));
    await waitFor(() => expect(within(dialog).getByTestId("subagent-prompt")).toHaveTextContent("the whole prompt"));
    expect(fetchMock.mock.calls[0]![0]).toBe(`/api/sessions/session-1/tool-inputs/${TASK_ID}`);
  });

  it("says when the turn ended before a report came back", () => {
    show([launch(task())]);
    expect(screen.getByTestId("subagent-done-toggle")).toHaveTextContent("Finished subagents · 1");
    const dialog = openLine("Count words");
    fireEvent.mouseDown(within(dialog).getByTestId("subagent-tab-report"));
    expect(dialog).toHaveTextContent("The turn ended before this sub-agent returned a report.");
  });
});

describe("SubagentLines — shipit agent run dialog (req 9)", () => {
  const runOn = { serviceId: "anthropic", billingMode: "sub" as const, modelId: "claude-opus-5", reasoningEffort: "high" };

  it("titles the dialog with the model, the run-on line, the output, time and cost", () => {
    vi.stubGlobal("fetch", vi.fn());
    show([{ role: "assistant", text: "", subAgentConsult: card({ subAgentId: "claude", runOn, roleName: "reviewer", outputMarkdown: "Two findings." }) }]);
    const dialog = openLine("Opus 5");

    expect(dialog).toHaveTextContent("as reviewer · Anthropic · Subscription · Claude · High reasoning");
    expect(within(dialog).getByTestId("sub-agent-consult-output")).toHaveTextContent("Two findings.");
    expect(dialog).toHaveTextContent("0:47");
    expect(dialog).toHaveTextContent("$0.42");
  });

  it("shows ShipIt's explanation of a failed run", () => {
    vi.stubGlobal("fetch", vi.fn());
    show([{ role: "assistant", text: "", subAgentConsult: card({ status: "timeout", statusDetail: "Timed out after 20 minutes." }) }]);
    expect(within(openLine("Codex")).getByTestId("sub-agent-consult-status-detail")).toHaveTextContent("Timed out after 20 minutes.");
  });

  it("fetches output the transcript left out, and nothing for output that arrived whole (docs/244)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ outputMarkdown: "The whole review." }) });
    vi.stubGlobal("fetch", fetchMock);
    show([{ role: "assistant", text: "", subAgentConsult: card({ outputMarkdown: "The whole", outputTruncated: true }) }]);
    const dialog = openLine("Codex");

    await waitFor(() => expect(within(dialog).getByTestId("sub-agent-consult-output")).toHaveTextContent("The whole review."));
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/sessions/session-1/sub-agent-consults/sac-1");
  });

  it("surfaces a failed fetch rather than a silently truncated review", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    show([{ role: "assistant", text: "", subAgentConsult: card({ outputMarkdown: "The whole", outputTruncated: true }) }]);
    const dialog = openLine("Codex");
    await waitFor(() => expect(within(dialog).getByTestId("sub-agent-consult-output")).toHaveTextContent("Couldn't load this output."));
  });

  it("shows the prompt of a running sub-agent, fetching it when the transcript left it out", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ outputMarkdown: "", prompt: "Review the whole diff." }) });
    vi.stubGlobal("fetch", fetchMock);
    show([{ role: "assistant", text: "", subAgentConsult: card({ status: "pending", promptTruncated: true }) }], { agentBusy: true });
    const dialog = openLine("Codex");
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.mouseDown(within(dialog).getByTestId("subagent-tab-prompt"));
    await waitFor(() => expect(within(dialog).getByTestId("subagent-prompt")).toHaveTextContent("Review the whole diff."));
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["/api/sessions/session-1/sub-agent-consults/sac-1?part=prompt"]);
  });

  it("shows a prompt that arrived whole without fetching, and says so for a card that has none", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    show([{ role: "assistant", text: "", subAgentConsult: card({ prompt: "Short ask." }) }]);
    let dialog = openLine("Codex");
    fireEvent.mouseDown(within(dialog).getByTestId("subagent-tab-prompt"));
    expect(within(dialog).getByTestId("subagent-prompt")).toHaveTextContent("Short ask.");
    expect(fetchMock).not.toHaveBeenCalled();
    cleanup();

    show([{ role: "assistant", text: "", subAgentConsult: card() }]);
    dialog = openLine("Codex");
    fireEvent.mouseDown(within(dialog).getByTestId("subagent-tab-prompt"));
    expect(within(dialog).getByTestId("subagent-prompt")).toHaveTextContent("No prompt recorded.");
  });
});
