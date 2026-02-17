import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { ThreadTimeline, type ThreadInfo } from "./ThreadTimeline.js";

afterEach(cleanup);

const mainThread: ThreadInfo = {
  id: "thread-main",
  sessionId: "session-1",
  parentCheckpointId: null,
  name: "main",
  checkpoints: [],
  isActive: true,
  createdAt: new Date().toISOString(),
};

const mainWithCheckpoints: ThreadInfo = {
  ...mainThread,
  checkpoints: [
    {
      id: "cp-1",
      sessionId: "session-1",
      messageIndex: 3,
      commitHash: "abc1234",
      createdAt: "2026-01-15T10:00:00Z",
      label: "Before refactor",
    },
    {
      id: "cp-2",
      sessionId: "session-1",
      messageIndex: 8,
      commitHash: "def5678",
      createdAt: "2026-01-15T11:00:00Z",
    },
  ],
};

const forkedThread: ThreadInfo = {
  id: "thread-2",
  sessionId: "session-1",
  parentCheckpointId: "cp-1",
  name: "Thread 1",
  checkpoints: [],
  isActive: false,
  createdAt: new Date().toISOString(),
};

describe("ThreadTimeline", () => {
  it("renders nothing when single thread with no checkpoints", () => {
    const { container } = render(
      <ThreadTimeline
        threads={[mainThread]}
        activeThreadId="thread-main"
        onForkThread={vi.fn()}
        onSwitchThread={vi.fn()}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders when there are checkpoints", () => {
    const { getByText } = render(
      <ThreadTimeline
        threads={[mainWithCheckpoints]}
        activeThreadId="thread-main"
        onForkThread={vi.fn()}
        onSwitchThread={vi.fn()}
      />,
    );
    expect(getByText("Thread Timeline")).toBeTruthy();
  });

  it("renders when there are multiple threads even without checkpoints", () => {
    const { getByText } = render(
      <ThreadTimeline
        threads={[mainThread, { ...forkedThread, parentCheckpointId: null }]}
        activeThreadId="thread-main"
        onForkThread={vi.fn()}
        onSwitchThread={vi.fn()}
      />,
    );
    expect(getByText("Thread Timeline")).toBeTruthy();
  });

  it("shows checkpoint count and thread count in header", () => {
    const { getByText } = render(
      <ThreadTimeline
        threads={[mainWithCheckpoints, forkedThread]}
        activeThreadId="thread-main"
        onForkThread={vi.fn()}
        onSwitchThread={vi.fn()}
      />,
    );
    expect(getByText(/2 checkpoints, 2 threads/)).toBeTruthy();
  });

  it("expands to show timeline on click", () => {
    const { getByText, queryByText } = render(
      <ThreadTimeline
        threads={[mainWithCheckpoints]}
        activeThreadId="thread-main"
        onForkThread={vi.fn()}
        onSwitchThread={vi.fn()}
      />,
    );

    expect(queryByText("Before refactor")).toBeNull();
    fireEvent.click(getByText("Thread Timeline"));
    expect(getByText("Before refactor")).toBeTruthy();
  });

  it("shows thread legend with color-coded buttons", () => {
    const { getByText, getAllByText } = render(
      <ThreadTimeline
        threads={[mainWithCheckpoints, forkedThread]}
        activeThreadId="thread-main"
        onForkThread={vi.fn()}
        onSwitchThread={vi.fn()}
      />,
    );

    fireEvent.click(getByText("Thread Timeline"));
    // "main" appears in legend and in checkpoint thread labels
    expect(getAllByText("main").length).toBeGreaterThanOrEqual(1);
    expect(getAllByText("Thread 1").length).toBeGreaterThanOrEqual(1);
  });

  it("calls onSwitchThread when clicking a non-active thread in legend", () => {
    const onSwitchThread = vi.fn();
    const { container, getByText } = render(
      <ThreadTimeline
        threads={[mainWithCheckpoints, forkedThread]}
        activeThreadId="thread-main"
        onForkThread={vi.fn()}
        onSwitchThread={onSwitchThread}
      />,
    );

    fireEvent.click(getByText("Thread Timeline"));
    // Find the Thread 1 button in the legend (rounded-full buttons)
    const legendButtons = container.querySelectorAll("button[class*='rounded-full']");
    const thread1Button = Array.from(legendButtons).find(
      (b) => b.textContent?.includes("Thread 1"),
    );
    expect(thread1Button).toBeTruthy();
    fireEvent.click(thread1Button!);
    expect(onSwitchThread).toHaveBeenCalledWith("thread-2");
  });

  it("does not call onSwitchThread when clicking the active thread", () => {
    const onSwitchThread = vi.fn();
    const { getByText } = render(
      <ThreadTimeline
        threads={[mainWithCheckpoints]}
        activeThreadId="thread-main"
        onForkThread={vi.fn()}
        onSwitchThread={onSwitchThread}
      />,
    );

    fireEvent.click(getByText("Thread Timeline"));
    // Click on the "main" legend button (which is in the legend)
    const buttons = document.querySelectorAll("button");
    const mainButton = Array.from(buttons).find(
      (b) => b.textContent?.includes("main") && b !== getByText("Thread Timeline"),
    );
    if (mainButton) fireEvent.click(mainButton);
    expect(onSwitchThread).not.toHaveBeenCalled();
  });

  it("shows fork buttons on checkpoints", () => {
    const onForkThread = vi.fn();
    const { getByText, getAllByText } = render(
      <ThreadTimeline
        threads={[mainWithCheckpoints]}
        activeThreadId="thread-main"
        onForkThread={onForkThread}
        onSwitchThread={vi.fn()}
      />,
    );

    fireEvent.click(getByText("Thread Timeline"));
    const forkButtons = getAllByText("fork");
    expect(forkButtons.length).toBe(2);

    fireEvent.click(forkButtons[0]);
    expect(onForkThread).toHaveBeenCalledWith("cp-1");
  });

  it("shows fork indicator when checkpoint has a child thread", () => {
    const { getByText } = render(
      <ThreadTimeline
        threads={[mainWithCheckpoints, forkedThread]}
        activeThreadId="thread-main"
        onForkThread={vi.fn()}
        onSwitchThread={vi.fn()}
      />,
    );

    fireEvent.click(getByText("Thread Timeline"));
    // The fork indicator shows the child thread name next to the checkpoint
    // There should be "Thread 1" shown as a fork indicator
    const thread1Elements = document.querySelectorAll("span");
    const forkIndicator = Array.from(thread1Elements).find(
      (el) => el.textContent?.includes("Thread 1") && el.classList.contains("shrink-0"),
    );
    expect(forkIndicator).toBeTruthy();
  });

  it("shows commit hash for checkpoints", () => {
    const { getByText } = render(
      <ThreadTimeline
        threads={[mainWithCheckpoints]}
        activeThreadId="thread-main"
        onForkThread={vi.fn()}
        onSwitchThread={vi.fn()}
      />,
    );

    fireEvent.click(getByText("Thread Timeline"));
    expect(getByText("abc1234")).toBeTruthy();
    expect(getByText("def5678")).toBeTruthy();
  });

  it("shows placeholder message when expanded with no checkpoints", () => {
    const { getByText } = render(
      <ThreadTimeline
        threads={[mainThread, { ...forkedThread, parentCheckpointId: null }]}
        activeThreadId="thread-main"
        onForkThread={vi.fn()}
        onSwitchThread={vi.fn()}
      />,
    );

    fireEvent.click(getByText("Thread Timeline"));
    expect(getByText("No checkpoints yet. Create one to start branching.")).toBeTruthy();
  });
});
