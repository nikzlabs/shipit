import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MessageList } from "./MessageList.js";
import type { ChatMessage } from "./types.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import { CARD_MESSAGE_FIELDS, buildVisualElements } from "../visual-elements.js";
import { compactRuns, isCompactDetail } from "./compact-turns.js";

beforeAll(() => { Element.prototype.scrollIntoView = () => {}; Range.prototype.getBoundingClientRect = () => new DOMRect(); });
afterEach(() => {
  cleanup();
  useSettingsStore.setState({ compactConversation: false });
  useSessionStore.setState({ sessionId: undefined });
  window.getSelection()?.removeAllRanges();
});
const user = (text: string): ChatMessage => ({ role: "user", text });
const bot = (text: string): ChatMessage => ({ role: "assistant", text });
const transcript = () => [user("Build search"), bot("Checking files"), {
  ...bot(""), toolUse: [{ type: "tool_use" as const, id: "read", name: "Read", input: { file_path: "/example.ts" } }],
  toolResults: [{ toolUseId: "read", content: "file content" }],
}, { ...bot(""), compaction: { trigger: "auto" } }, bot("Search is ready") ] as ChatMessage[];
const compactOn = () => act(() => { useSettingsStore.setState({ compactConversation: true }); });

describe("compact completed conversation", () => {
  it("defaults to full, hides detail on opt-in, and retains card DOM and row parents across toggles", () => {
    const data = transcript();
    const { container } = render(<MessageList messages={data} isLoading={false} />);
    const progress = screen.getByText("Checking files");
    const card = screen.getByText("Context compacted");
    const parents = [...container.querySelectorAll("[data-compact-content]")].map((row) => row.parentElement?.parentElement);
    expect(progress).toBeVisible();
    compactOn();
    expect(progress).not.toBeVisible();
    expect(screen.getByText("Search is ready")).toBeVisible();
    expect(card).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Show full turn/ }));
    expect(progress).toBeVisible();
    expect(screen.getByText("Context compacted")).toBe(card);
    fireEvent.click(screen.getByRole("button", { name: /Show compact turn/ }));
    expect(progress).not.toBeVisible();
    expect([...container.querySelectorAll("[data-compact-content]")].map((row) => row.parentElement?.parentElement)).toEqual(parents);
  });

  it("keeps every active row visible across tool groups and steered input, then folds on completion", () => {
    compactOn();
    const history = transcript();
    const { rerender } = render(<MessageList messages={history} isLoading={false} />);
    const active = [...history, user("Next task"), bot("Live progress"), user("Use TypeScript"), bot("Working now")];
    rerender(<MessageList messages={active} isLoading />);
    expect(screen.getByText("Checking files")).not.toBeVisible();
    expect(screen.getByText("Live progress")).toBeVisible();
    rerender(<MessageList messages={[...active, bot("Still working"), bot("Done")]} isLoading />);
    expect(screen.getByText("Still working")).toBeVisible();
    rerender(<MessageList messages={[...active, bot("Still working"), bot("Done")]} isLoading={false} />);
    expect(screen.getByText("Still working")).not.toBeVisible();
    expect(screen.getByText("Done")).toBeVisible();
  });

  it("leaves an attach during an active turn full, including rows without streaming flags", () => {
    compactOn();
    render(<MessageList messages={transcript()} isLoading />);
    expect(screen.getByText("Checking files")).toBeVisible();
  });

  it("reveals hidden message search matches without losing them from history", () => {
    compactOn();
    const data = transcript();
    const { rerender } = render(<MessageList messages={data} isLoading={false} />);
    expect(screen.getByText("Checking files")).not.toBeVisible();
    rerender(<MessageList messages={data} isLoading={false} searchMatches={[{ messageIndex: 1, start: 0, length: 8 }]} />);
    expect(document.querySelector('[data-compact-index="1"]')).toBeVisible();
    expect(screen.getByRole("button", { name: /Show compact turn/ })).toHaveAttribute("aria-disabled", "true");
    rerender(<MessageList messages={data} isLoading={false} />);
    expect(screen.getByText("Checking files")).not.toBeVisible();
  });

  it("keeps errors and attachments, gives tool-only runs an honest fallback", () => {
    compactOn();
    render(<MessageList messages={[user("Check"), { ...bot(""), toolUse: [{ type: "tool_use" as const, id: "r", name: "Read", input: {} }] }, { ...bot("Process stopped"), isError: true }]} isLoading={false} />);
    expect(screen.getByText("Process stopped")).toBeVisible();
    expect(screen.queryByText("Turn ended without an agent reply.")).not.toBeInTheDocument();
    const data = [user("Check"), { ...bot("Attachment"), images: [{ data: "abc", mediaType: "image/png" }] }, bot("Done")] as ChatMessage[];
    const run = compactRuns(data, Infinity)[0];
    expect(isCompactDetail({ kind: "message", index: 1, hideTools: false }, data, run)).toBe(false);
  });

  it("keeps the assistant rewind handle when its first prose is hidden", () => {
    compactOn();
    const { container } = render(<MessageList messages={transcript()} isLoading={false} onRewindAtGap={vi.fn()} />);
    const progress = screen.getByText("Checking files").closest("[data-compact-content]")!;
    expect(progress).not.toBeVisible();
    expect(progress.previousElementSibling).toBeVisible();
    expect(container.querySelectorAll("[data-compact-content]").length).toBeGreaterThan(0);
  });

  it("protects selected progress prose on settlement until selection clears", () => {
    compactOn();
    const data = transcript();
    const { rerender } = render(<MessageList messages={data} isLoading />);
    const progress = screen.getByText("Checking files");
    const range = document.createRange();
    range.selectNodeContents(progress);
    window.getSelection()?.addRange(range);
    fireEvent(document, new Event("selectionchange"));
    rerender(<MessageList messages={data} isLoading={false} />);
    expect(progress).toBeVisible();
    window.getSelection()?.removeAllRanges();
    fireEvent(document, new Event("selectionchange"));
    expect(progress).not.toBeVisible();
  });

  it("keeps later row DOM parents fixed when an early run is expanded", () => {
    compactOn();
    const data = Array.from({ length: 30 }, (_, i) => [user(`Task ${i}`), bot(`Progress ${i}`), bot(`Result ${i}`)]).flat();
    render(<MessageList messages={data} isLoading={false} />);
    const tail = screen.getByText("Result 29");
    const parent = tail.closest("[data-compact-content]")?.parentElement?.parentElement;
    fireEvent.click(screen.getAllByRole("button", { name: /Show full turn/ })[0]);
    expect(screen.getByText("Result 29")).toBe(tail);
    expect(tail.closest("[data-compact-content]")?.parentElement?.parentElement).toBe(parent);
    expect(screen.getByText("Progress 0")).toBeVisible();
    expect(screen.getByText("Progress 29")).not.toBeVisible();
  });

  it("does not reserve blank groups for a long compacted turn", () => {
    compactOn();
    const data = [user("Long task"), ...Array.from({ length: 65 }, (_, i) => bot(`Step ${i}`)), bot("Final answer")];
    const { container } = render(<MessageList messages={data} isLoading={false} />);
    const groups = [...container.querySelectorAll<HTMLElement>("[data-compact-group]")];
    expect(groups.some((group) => group.hidden)).toBe(true);
    expect(screen.getByText("Final answer")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Show full turn/ }));
    expect(groups.every((group) => !group.hidden)).toBe(true);
    expect(screen.getByText("Step 40")).toBeVisible();
  });

  it("resets expansion on session switch and keeps late cards visible without reopening prose", () => {
    compactOn();
    useSessionStore.setState({ sessionId: "first" });
    const data = transcript();
    const { rerender } = render(<MessageList messages={data} isLoading={false} />);
    fireEvent.click(screen.getByRole("button", { name: /Show full turn/ }));
    act(() => { useSessionStore.setState({ sessionId: "second" }); });
    expect(screen.getByText("Checking files")).not.toBeVisible();
    rerender(<MessageList messages={[...data, { ...bot(""), compaction: { trigger: "manual" } } as ChatMessage]} isLoading={false} />);
    expect(screen.getByText("Checking files")).not.toBeVisible();
    expect(screen.getAllByText("Context compacted")).toHaveLength(2);
  });

  it("retains a question carried inside an intermediate prose bubble", () => {
    compactOn();
    render(<MessageList messages={[user("Task"), {
      ...bot("Choose the search scope."),
      toolUse: [{ type: "tool_use", id: "question", name: "AskUserQuestion", input: {
        questions: [{ header: "Scope", question: "Which scope?", options: [{ label: "File names", description: "Names only" }, { label: "Full paths", description: "Include folders" }], multiSelect: false }],
      } }],
      toolResults: [{ toolUseId: "question", content: "File names" }],
    }, bot("Implementing"), bot("Done")]} isLoading={false} />);
    expect(screen.getByText("Which scope?")).toBeVisible();
    expect(screen.getByText("File names")).toBeVisible();
    expect(screen.getByText("Implementing")).not.toBeVisible();
  });

  it("hides progress prose carried by task-list tools", () => {
    const data: ChatMessage[] = [user("Task"), { ...bot("Planning"), toolUse: [{ type: "tool_use", id: "todo", name: "TodoWrite", input: { todos: [] } }] }, bot("Done")];
    const run = compactRuns(data, Infinity)[0];
    const element = buildVisualElements(data).find((el) => el.kind === "message" && el.index === 1)!;
    expect(isCompactDetail(element, data, run)).toBe(true);
  });

  it("shows a no-reply label only for a collapsed run without any text", () => {
    compactOn();
    const data: ChatMessage[] = [user("Task"), { ...bot(""), toolUse: [{ type: "tool_use", id: "r", name: "Read", input: {} }] }];
    render(<MessageList messages={data} isLoading={false} />);
    expect(screen.getByText("Turn ended without an agent reply.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Show full turn/ }));
    expect(screen.queryByText("Turn ended without an agent reply.")).not.toBeInTheDocument();
  });

  it.each([false, true])("does not scroll-pin an append while text is selected (compact=%s)", (enabled) => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 0);
    useSettingsStore.setState({ compactConversation: enabled });
    const history = transcript();
    const { container, rerender } = render(<MessageList messages={history} isLoading={false} />);
    const active = [...history, user("Continue"), bot("Selected live text")];
    rerender(<MessageList messages={active} isLoading />);
    const scroll = container.firstElementChild!;
    const writeScroll = vi.fn();
    Object.defineProperties(scroll, {
      scrollTop: { configurable: true, get: () => 400, set: writeScroll },
      scrollHeight: { configurable: true, get: () => 920 },
      clientHeight: { configurable: true, get: () => 500 },
    });
    const range = document.createRange();
    range.selectNodeContents(screen.getByText("Selected live text"));
    window.getSelection()?.addRange(range);
    fireEvent(document, new Event("selectionchange"));
    writeScroll.mockClear();
    rerender(<MessageList messages={[...active, bot("New group")]} isLoading />);
    expect(writeScroll).not.toHaveBeenCalled();
    expect(screen.getByText("Selected live text")).toBeVisible();
    vi.restoreAllMocks();
  });

  it("keeps an unrelated selection when a turn is collapsed", () => {
    compactOn();
    render(<><div data-testid="outside">Selected outside the conversation</div><MessageList messages={transcript()} isLoading={false} /></>);
    fireEvent.click(screen.getByRole("button", { name: /Show full turn/ }));
    const range = document.createRange();
    range.selectNodeContents(screen.getByTestId("outside"));
    window.getSelection()?.addRange(range);
    fireEvent(document, new Event("selectionchange"));
    fireEvent.click(screen.getByRole("button", { name: /Show compact turn/ }));
    expect(window.getSelection()?.toString()).toBe("Selected outside the conversation");
  });

  it("never hides registered card types or native standalone tools", () => {
    for (const field of CARD_MESSAGE_FIELDS) {
      const data = [user("Task"), { ...bot(""), [field]: {} }, bot("Done")];
      const run = compactRuns(data, Infinity)[0];
      expect(isCompactDetail({ kind: "message", index: 1, hideTools: false }, data, run), field).toBe(false);
    }
    const data = [user("Task"), { ...bot("Progress"), toolUse: [
      { type: "tool_use" as const, id: "q", name: "AskUserQuestion", input: {} }, { type: "tool_use" as const, id: "a", name: "Agent", input: {} },
    ] }, bot("Done")];
    const run = compactRuns(data, Infinity)[0];
    for (const el of buildVisualElements(data).filter((el) => el.kind === "subagent" || el.kind === "standalone-tool")) {
      expect(isCompactDetail(el, data, run)).toBe(false);
    }
  });
});
