import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MessageList } from "./MessageList.js";
import type { ChatMessage } from "./types.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useBugReportStore } from "../../stores/bug-report-store.js";
import { usePermissionStore } from "../../stores/permission-store.js";
import { useEgressPromptStore } from "../../stores/egress-prompt-store.js";
import { buildVisualElements } from "../visual-elements.js";
import { compactRuns, isCompactDetail, shouldCollapseRowTools } from "./compact-turns.js";

beforeAll(() => { Element.prototype.scrollIntoView = () => {}; Range.prototype.getBoundingClientRect = () => new DOMRect(); });
afterEach(() => {
  cleanup();
  useSettingsStore.setState({ compactConversation: false });
  useSessionStore.setState({ sessionId: undefined });
  useBugReportStore.getState().reset();
  usePermissionStore.getState().reset();
  useEgressPromptStore.getState().reset();
  window.getSelection()?.removeAllRanges();
});
const user = (text: string): ChatMessage => ({ role: "user", text });
const bot = (text: string): ChatMessage => ({ role: "assistant", text });
const noNeeds = () => false;

/** One collapsible turn (a later user row closes it) followed by the newest turn. */
const transcript = () => [user("Build search"), bot("Checking files"), {
  ...bot(""), toolUse: [{ type: "tool_use" as const, id: "read", name: "Read", input: { file_path: "/example.ts" } }],
  toolResults: [{ toolUseId: "read", content: "file content" }],
}, { ...bot(""), compaction: { trigger: "auto" } }, bot("Search is ready"),
  user("Next task"), bot("Working now")] as ChatMessage[];
const compactOn = () => act(() => { useSettingsStore.setState({ compactConversation: true }); });

describe("collapsed turns", () => {
  it("defaults to full, and on opt-in keeps the request and the reply while hiding the rest", () => {
    const data = transcript();
    const { container } = render(<MessageList messages={data} isLoading={false} />);
    const progress = screen.getByText("Checking files");
    const card = screen.getByText("Context compacted");
    const parents = [...container.querySelectorAll("[data-compact-content]")].map((row) => row.parentElement?.parentElement);
    expect(progress).toBeVisible();
    compactOn();
    expect(progress).not.toBeVisible();
    expect(screen.getByText("Build search")).toBeVisible();
    expect(screen.getByText("Search is ready")).toBeVisible();
    // req 5 — a card the user cannot act on is not relevant in a past turn.
    expect(card).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Show full turn/ }));
    expect(progress).toBeVisible();
    expect(screen.getByText("Context compacted")).toBe(card);
    fireEvent.click(screen.getByRole("button", { name: /Show compact turn/ }));
    expect(progress).not.toBeVisible();
    expect([...container.querySelectorAll("[data-compact-content]")].map((row) => row.parentElement?.parentElement)).toEqual(parents);
  });

  it("never collapses the newest turn, and collapses it as soon as a newer one starts (req 1)", () => {
    compactOn();
    const history = [user("Build search"), bot("Checking files"), bot("Search is ready")];
    const { rerender } = render(<MessageList messages={history} isLoading={false} />);
    expect(screen.getByText("Checking files")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Show full turn/ })).not.toBeInTheDocument();

    const next = [...history, user("Next task")];
    rerender(<MessageList messages={next} isLoading={false} />);
    expect(screen.getByText("Checking files")).not.toBeVisible();
    expect(screen.getByText("Search is ready")).toBeVisible();

    rerender(<MessageList messages={[...next, bot("Live progress"), bot("Done")]} isLoading />);
    expect(screen.getByText("Checking files")).not.toBeVisible();
    expect(screen.getByText("Live progress")).toBeVisible();
  });

  it("collapses earlier turns when the viewer attaches during a turn (req 4)", () => {
    compactOn();
    render(<MessageList messages={transcript()} isLoading />);
    expect(screen.getByText("Checking files")).not.toBeVisible();
    expect(screen.getByText("Working now")).toBeVisible();
  });

  it("reads no per-row activity flag, so a watcher and a reconnector agree", () => {
    compactOn();
    const watched = transcript();
    // What an attach snapshot produces for the same rows: every execution row flagged.
    const reconnected = watched.map((m) =>
      m.role === "assistant" ? { ...m, inProgress: true, streaming: true } : m);
    const visibility = (data: ChatMessage[]) => {
      const { container, unmount } = render(<MessageList messages={data} isLoading={false} />);
      const state = [...container.querySelectorAll<HTMLElement>("[data-compact-content]")]
        .map((row) => row.hidden).join();
      unmount();
      return state;
    };
    expect(visibility(reconnected)).toBe(visibility(watched));
  });

  it("documents the one shape where the two disagree: a steer during streaming prose", () => {
    // `recordSteeredMessage` computes an afterGroupIndex but does not arm
    // `needsNewMessageGroup` (`agent-message-builder.ts`), so later prose merges
    // into the group BEFORE the steer. The watcher appended it after its own
    // user row. Arming that boundary is its own change; until then this is the
    // known difference, pinned here rather than left to be discovered.
    const watched = [user("Build it"), bot("Starting"), user("Use TypeScript"), bot("Switching over")];
    const reconstructed = [user("Build it"), bot("Starting\n\nSwitching over"), user("Use TypeScript")];
    expect(compactRuns(watched).map((r) => [r.start, r.end])).toEqual([[1, 2]]);
    expect(compactRuns(reconstructed).map((r) => [r.start, r.end])).toEqual([[1, 2]]);
    // The watcher shows "Switching over" as the newest turn; the reconnector
    // has it inside the collapsed run, kept only because it is that run's reply.
    expect(compactRuns(reconstructed)[0].lastReply).toBe(1);
  });

  it("hides a tool group whether or not one of its tools failed (req 2)", () => {
    const failing: ChatMessage[] = [user("Deploy"), {
      ...bot(""), toolUse: [{ type: "tool_use", id: "b", name: "Bash", input: { command: "npm test" } }],
      toolResults: [{ toolUseId: "b", content: "boom", isError: true }],
    }, bot("The tests fail"), user("Next")];
    const run = compactRuns(failing)[0];
    const group = buildVisualElements(failing).find((el) => el.kind === "tool-group")!;
    expect(isCompactDetail(group, failing, run, noNeeds)).toBe(true);
  });

  it("collapses an interrupted turn but keeps its error row and notices (req 3, 11)", () => {
    compactOn();
    render(<MessageList messages={[
      user("Check"), bot("Starting"), bot("Halfway through"),
      { ...bot("Process stopped"), isError: true },
      { ...bot("Agent switched accounts"), notice: true, noticeLevel: "info" as const },
      user("Next"), bot("Working now"),
    ]} isLoading={false} />);
    expect(screen.getByText("Starting")).not.toBeVisible();
    expect(screen.getByText("Halfway through")).toBeVisible();
    expect(screen.getByText("Process stopped")).toBeVisible();
    expect(screen.getByText("Agent switched accounts")).toBeVisible();
  });

  it("keeps a last reply made of images or files, not only text (req 5)", () => {
    const withImage = [user("Chart it"), bot("Rendering"), {
      ...bot(""), images: [{ data: "abc", mediaType: "image/png" }],
    }, user("Next")] as ChatMessage[];
    const run = compactRuns(withImage)[0];
    expect(run.lastReply).toBe(2);
    expect(isCompactDetail({ kind: "message", index: 2, hideTools: false }, withImage, run, noNeeds)).toBe(false);
    expect(isCompactDetail({ kind: "message", index: 1, hideTools: false }, withImage, run, noNeeds)).toBe(true);
  });

  it("does not let an appended error row displace the turn's reply", () => {
    const data = [user("Check"), bot("Here is the answer"), { ...bot("Turn failed"), isError: true }, user("Next")] as ChatMessage[];
    expect(compactRuns(data)[0].lastReply).toBe(1);
  });

  it("keeps a code rollback notice visible when its own row is hidden", () => {
    compactOn();
    render(<MessageList messages={[
      user("Undo that"), { ...bot("Reverted work"), rolledBack: true, codeRollbackHash: "abcdef1234" },
      bot("Ready"), user("Next"), bot("Working now"),
    ]} isLoading={false} />);
    expect(screen.getByText("Reverted work")).not.toBeVisible();
    expect(screen.getByText(/Code rolled back to abcdef1/)).toBeVisible();
  });

  it("keeps a card that still needs the user and hides one already acted on (req 12)", () => {
    compactOn();
    const pending = { cardId: "c1", phase: "draft" as const, title: "Broken", body: "Details", stage2Ran: true, producer: "session" as const };
    act(() => { useBugReportStore.getState().seedCards([pending]); });
    const data = [user("File it"), { ...bot(""), bugReport: pending }, bot("Filed for you"), user("Next"), bot("Working now")] as ChatMessage[];
    const { rerender } = render(<MessageList messages={data} isLoading={false} />);
    expect(screen.getByTestId("bug-report-card")).toBeVisible();

    act(() => { useBugReportStore.getState().setFiled("c1", 7, "https://example.test/7"); });
    rerender(<MessageList messages={data} isLoading={false} />);
    expect(screen.getByTestId("bug-report-card")).not.toBeVisible();
  });

  it("keeps an unsent bug-report draft mounted with its edits when its turn collapses", () => {
    compactOn();
    const draft = { cardId: "c2", phase: "draft" as const, title: "Broken", body: "Details", stage2Ran: true, producer: "session" as const };
    act(() => { useBugReportStore.getState().seedCards([draft]); });
    const history = [user("File it"), { ...bot(""), bugReport: draft }] as ChatMessage[];
    const { rerender } = render(<MessageList messages={history} isLoading={false} />);
    const title = screen.getByLabelText("Bug report title");
    fireEvent.change(title, { target: { value: "Edited by hand" } });

    rerender(<MessageList messages={[...history, user("Next"), bot("Working now")]} isLoading={false} />);
    expect(screen.getByLabelText("Bug report title")).toBe(title);
    expect(title).toBeVisible();
    expect((title as HTMLInputElement).value).toBe("Edited by hand");
  });

  it("does not discard an answer typed into a question when its turn collapses", () => {
    compactOn();
    const history = [user("Task"), {
      ...bot("Choose the search scope."),
      toolUse: [{ type: "tool_use" as const, id: "question", name: "AskUserQuestion", input: {
        questions: [{ header: "Scope", question: "Which scope?", options: [{ label: "File names", description: "Names only" }], multiSelect: false }],
      } }],
    }] as ChatMessage[];
    const { rerender } = render(<MessageList messages={history} isLoading={false} />);
    fireEvent.click(screen.getByTestId("option-other"));
    const input = screen.getByTestId("other-input");
    fireEvent.change(input, { target: { value: "Only the src folder" } });

    // A new turn arrives. Focus is inside this one, so protection keeps it open.
    rerender(<MessageList messages={[...history, user("Next"), bot("Working now")]} isLoading={false} />);
    expect(input).toBeVisible();

    // Collapsing it by hand hides the subtree — and does not unmount it.
    fireEvent.click(screen.getByRole("button", { name: /Show compact turn/ }));
    expect(screen.getByTestId("other-input")).toBe(input);
    expect(input).not.toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /Show full turn/ }));
    expect(screen.getByTestId("other-input")).toBe(input);
    expect(input).toBeVisible();
    expect((input as HTMLTextAreaElement).value).toBe("Only the src folder");
  });

  it("restores the reading anchor when only a tool subtree changes height", () => {
    compactOn();
    // A turn whose reply is KEPT and whose tools are hidden: expanding it moves
    // nothing in the row-hidden half, so the layout signal has to carry the
    // tool state too or `CompactLayout` skips restoration entirely.
    const data = [user("Plan it"), {
      ...bot("Here is the plan."),
      toolUse: [{ type: "tool_use" as const, id: "plan", name: "ExitPlanMode", input: { plan: "Do the work" } }],
      toolResults: [{ toolUseId: "plan", content: "approved" }],
    }, user("Next"), bot("Working now")] as ChatMessage[];
    vi.spyOn(Element.prototype, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(0, 10, 100, 40));
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 0);
    const { container } = render(<MessageList messages={data} isLoading={false} />);
    const scroll = container.firstElementChild!;
    const writeScroll = vi.fn();
    Object.defineProperties(scroll, {
      scrollTop: { configurable: true, get: () => 400, set: writeScroll },
      scrollHeight: { configurable: true, get: () => 4000 },
      clientHeight: { configurable: true, get: () => 500 },
    });
    // Scrolled far from the bottom, so the reading anchor is live.
    fireEvent.scroll(scroll);
    writeScroll.mockClear();

    fireEvent.click(screen.getByRole("button", { name: /Show full turn/ }));
    expect(writeScroll).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("hides a kept row's own tool subtree without unmounting it", () => {
    compactOn();
    const data = [user("Task"), {
      ...bot("Here is the plan."),
      toolUse: [{ type: "tool_use" as const, id: "plan", name: "ExitPlanMode", input: { plan: "Do the work" } }],
      toolResults: [{ toolUseId: "plan", content: "approved" }],
    }, user("Next"), bot("Working now")] as ChatMessage[];
    const element = buildVisualElements(data).find((el) => el.kind === "message" && el.index === 1)!;
    expect(shouldCollapseRowTools(element, data[1])).toBe(true);

    render(<MessageList messages={data} isLoading={false} />);
    const prose = screen.getByText("Here is the plan.");
    const tools = screen.getByTestId("plan-approval");
    expect(prose).toBeVisible();
    expect(tools).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Show full turn/ }));
    expect(screen.getByTestId("plan-approval")).toBe(tools);
    expect(tools).toBeVisible();
  });

  it("performs a press inside a protected turn instead of collapsing under the pointer", () => {
    compactOn();
    const send = vi.fn(() => true);
    const data = [user("Plan it"), {
      ...bot("Here is the plan."),
      toolUse: [{ type: "tool_use" as const, id: "plan", name: "ExitPlanMode", input: { plan: "Do the work" } }],
    }, user("Next"), bot("Working now")] as ChatMessage[];
    render(<MessageList messages={data} isLoading={false} onSendFollowUp={send} />);

    const prose = screen.getByText("Here is the plan.");
    expect(screen.getByTestId("plan-approval")).not.toBeVisible();
    const range = document.createRange();
    range.selectNodeContents(prose);
    window.getSelection()?.addRange(range);
    fireEvent(document, new Event("selectionchange"));
    const accept = screen.getByTestId("accept-plan");
    expect(accept).toBeVisible();

    // planning#540 — the press collapses the selection and moves focus before
    // `click` lands. Nothing may hide under a pointer that is already down.
    fireEvent.mouseDown(accept);
    window.getSelection()?.removeAllRanges();
    fireEvent(document, new Event("selectionchange"));
    fireEvent.focusIn(accept);
    expect(accept).toBeVisible();
    fireEvent.click(accept);
    expect(send).toHaveBeenCalled();
  });

  it("keeps a turn open once focus or a selection has entered it", () => {
    compactOn();
    const data = transcript();
    render(<MessageList messages={data} isLoading={false} />);
    const progress = screen.getByText("Checking files");
    expect(progress).not.toBeVisible();

    const range = document.createRange();
    range.selectNodeContents(progress);
    window.getSelection()?.addRange(range);
    fireEvent(document, new Event("selectionchange"));
    window.getSelection()?.removeAllRanges();
    fireEvent(document, new Event("selectionchange"));
    // One-way protection (planning#540): only the button closes it again.
    expect(progress).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Show compact turn/ }));
    expect(progress).not.toBeVisible();
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

  it("keeps the assistant rewind handle when its first prose is hidden", () => {
    compactOn();
    const { container } = render(<MessageList messages={transcript()} isLoading={false} onRewindAtGap={vi.fn()} />);
    const progress = screen.getByText("Checking files").closest("[data-compact-content]")!;
    expect(progress).not.toBeVisible();
    expect(progress.previousElementSibling).toBeVisible();
    expect(container.querySelectorAll("[data-compact-content]").length).toBeGreaterThan(0);
  });

  it("draws the user's rewind anchor above the expand control, in both states", () => {
    compactOn();
    const { container } = render(<MessageList messages={transcript()} isLoading={false} onRewindAtGap={vi.fn()} />);
    // Right-aligned anchors close a user message: this turn's and the newest one's.
    const anchors = () => [...container.querySelectorAll('[data-testid="rewind-point"][data-align="right"]')];
    const above = () => {
      const button = screen.getByRole("button", { name: /Show (full|compact) turn/ });
      return anchors().filter((a) => a.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).length;
    };
    // The anchor closes the user's message; the control opens the reply. The
    // count pins that hoisting it does not leave a second copy on its own row.
    expect(anchors()).toHaveLength(2);
    expect(above()).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: /Show full turn/ }));
    expect(anchors()).toHaveLength(2);
    expect(above()).toBe(1);
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
    // The newest turn is never collapsed, so its progress row stays.
    expect(screen.getByText("Progress 29")).toBeVisible();
    expect(screen.getByText("Progress 28")).not.toBeVisible();
  });

  it("does not reserve blank groups for a long collapsed turn", () => {
    compactOn();
    const data = [user("Long task"), ...Array.from({ length: 65 }, (_, i) => bot(`Step ${i}`)), bot("Final answer"), user("Next"), bot("Working now")];
    const { container } = render(<MessageList messages={data} isLoading={false} />);
    const groups = [...container.querySelectorAll<HTMLElement>("[data-compact-group]")];
    expect(groups.some((group) => group.hidden)).toBe(true);
    expect(screen.getByText("Final answer")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Show full turn/ }));
    expect(groups.every((group) => !group.hidden)).toBe(true);
    expect(screen.getByText("Step 40")).toBeVisible();
  });

  it("resets expansion on session switch", () => {
    compactOn();
    useSessionStore.setState({ sessionId: "first" });
    const data = transcript();
    render(<MessageList messages={data} isLoading={false} />);
    fireEvent.click(screen.getByRole("button", { name: /Show full turn/ }));
    expect(screen.getByText("Checking files")).toBeVisible();
    act(() => { useSessionStore.setState({ sessionId: "second" }); });
    expect(screen.getByText("Checking files")).not.toBeVisible();
  });

  it("labels a collapsed turn only when it would otherwise be the button alone", () => {
    compactOn();
    const toolOnly: ChatMessage[] = [user("Task"), { ...bot(""), toolUse: [{ type: "tool_use", id: "r", name: "Read", input: {} }] }, user("Next"), bot("Working now")];
    const { rerender } = render(<MessageList messages={toolOnly} isLoading={false} />);
    expect(screen.getByText("Turn ended without an agent reply.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Show full turn/ }));
    expect(screen.queryByText("Turn ended without an agent reply.")).not.toBeInTheDocument();

    // An error row explains itself; the label beside it would be noise.
    rerender(<MessageList messages={[
      user("Task"), { ...bot(""), toolUse: [{ type: "tool_use" as const, id: "r", name: "Read", input: {} }] },
      { ...bot("Process stopped"), isError: true }, user("Next"), bot("Working now"),
    ] as ChatMessage[]} isLoading={false} />);
    expect(screen.getByText("Process stopped")).toBeVisible();
    expect(screen.queryByText("Turn ended without an agent reply.")).not.toBeInTheDocument();

    // And a turn whose reply is an image is not a turn without a reply.
    rerender(<MessageList messages={[
      user("Chart it"), { ...bot(""), images: [{ data: "abc", mediaType: "image/png" }] },
      { ...bot(""), toolUse: [{ type: "tool_use" as const, id: "r2", name: "Read", input: {} }] },
      user("Next"), bot("Working now"),
    ] as ChatMessage[]} isLoading={false} />);
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

  it("keeps an action checklist in a collapsed turn, submitted or not (req 12)", () => {
    compactOn();
    const base = { cardId: "a1", actions: [{ id: "1", label: "Open a PR", payload: "Open a PR" }], createdAt: "2026-09-13T00:00:00.000Z" };
    const withCard = (card: typeof base & { submittedAt?: string }): ChatMessage[] =>
      [user("Task"), bot("Working on it"), { ...bot(""), actionChecklist: card }, bot("Done"),
        user("Next"), bot("Working now")];

    const { rerender } = render(<MessageList messages={withCard(base)} isLoading={false} />);
    expect(screen.getByTestId("action-checklist-card")).toBeVisible();

    rerender(<MessageList messages={withCard({ ...base, submittedAt: "2026-09-13T01:00:00.000Z" })} isLoading={false} />);
    expect(screen.getByTestId("action-checklist-card")).toBeVisible();
    // The turn is genuinely collapsed around it: the reply stays, the rest goes.
    expect(screen.getByText("Done")).toBeVisible();
    expect(screen.getByText("Working on it")).not.toBeVisible();
  });

  it("reads each pending card's own source of truth (req 12)", () => {
    compactOn();
    const release = (phase: "proposed" | "released") => ({
      sessionId: "s1", cardId: "r1", phase, version: "0.3.0", tag: "v0.3.0", prerelease: false,
    });
    const egress = { cardId: "e1", host: "cdn.example.test", phase: "pending" as const };
    act(() => { useEgressPromptStore.getState().seedCards([egress]); });

    const data = (releasePhase: "proposed" | "released"): ChatMessage[] => [
      user("Ship it"), { ...bot(""), egressPrompt: egress },
      { ...bot(""), releaseCard: release(releasePhase) }, bot("Done"), user("Next"), bot("Working now"),
    ];
    const { rerender } = render(<MessageList messages={data("proposed")} isLoading={false} />);
    expect(screen.getByTestId("egress-prompt-card")).toBeVisible();
    expect(screen.getByText("Release proposed")).toBeVisible();

    act(() => { useEgressPromptStore.getState().setPhase("e1", "added"); });
    rerender(<MessageList messages={data("released")} isLoading={false} />);
    expect(screen.getByTestId("egress-prompt-card")).not.toBeVisible();
    expect(screen.getByText("Released")).not.toBeVisible();
  });

  it("hides a question and a plan approval that a later message has superseded (req 2)", () => {
    compactOn();
    // No tool is kept, not even one with no result: the Codex worker emits the
    // question card itself and its adapter drops the matching result, so an
    // absent result cannot mean "unanswered" on both harnesses.
    const data = [user("Task"), {
      ...bot("Choose the scope."),
      toolUse: [{ type: "tool_use" as const, id: "q", name: "AskUserQuestion", input: {
        questions: [{ header: "Scope", question: "Which scope?", options: [{ label: "File names", description: "Names only" }], multiSelect: false }],
      } }],
    }, {
      ...bot(""),
      toolUse: [{ type: "tool_use" as const, id: "p", name: "ExitPlanMode", input: { plan: "Do the work" } }],
    }, bot("Done"), user("Next"), bot("Working now")] as ChatMessage[];
    render(<MessageList messages={data} isLoading={false} />);
    expect(screen.getByText("Choose the scope.")).not.toBeVisible();
    expect(screen.getByTestId("ask-user-question")).not.toBeVisible();
    expect(screen.getByTestId("plan-approval")).not.toBeVisible();
    expect(screen.getByText("Done")).toBeVisible();
  });
});
