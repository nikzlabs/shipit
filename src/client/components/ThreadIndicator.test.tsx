import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { ThreadIndicator, type ThreadInfo } from "./ThreadIndicator.js";

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

const threadWithCheckpoint: ThreadInfo = {
  id: "thread-main",
  sessionId: "session-1",
  parentCheckpointId: null,
  name: "main",
  checkpoints: [
    {
      id: "cp-1",
      sessionId: "session-1",
      messageIndex: 5,
      commitHash: "abc123",
      createdAt: new Date().toISOString(),
      label: "Before refactor",
    },
  ],
  isActive: true,
  createdAt: new Date().toISOString(),
};

const secondThread: ThreadInfo = {
  id: "thread-2",
  sessionId: "session-1",
  parentCheckpointId: "cp-1",
  name: "Thread 1",
  checkpoints: [],
  isActive: false,
  createdAt: new Date().toISOString(),
};

describe("ThreadIndicator", () => {
  it("renders nothing when no threads", () => {
    const { container } = render(
      <ThreadIndicator
        threads={[]}
        activeThreadId=""
        onCreateCheckpoint={vi.fn()}
        onForkThread={vi.fn()}
        onSwitchThread={vi.fn()}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("shows active thread name", () => {
    const { getByText } = render(
      <ThreadIndicator
        threads={[mainThread]}
        activeThreadId="thread-main"
        onCreateCheckpoint={vi.fn()}
        onForkThread={vi.fn()}
        onSwitchThread={vi.fn()}
      />,
    );
    expect(getByText("main")).toBeTruthy();
  });

  it("opens dropdown on click", () => {
    const { getByText, queryByText } = render(
      <ThreadIndicator
        threads={[mainThread]}
        activeThreadId="thread-main"
        onCreateCheckpoint={vi.fn()}
        onForkThread={vi.fn()}
        onSwitchThread={vi.fn()}
      />,
    );

    // Dropdown content not visible initially
    expect(queryByText("Threads")).toBeNull();

    // Click to open
    fireEvent.click(getByText("main"));
    expect(getByText("Threads")).toBeTruthy();
  });

  it("calls onSwitchThread when clicking another thread", () => {
    const onSwitchThread = vi.fn();
    const { getByText } = render(
      <ThreadIndicator
        threads={[{ ...mainThread, isActive: false }, { ...secondThread, isActive: true }]}
        activeThreadId="thread-2"
        onCreateCheckpoint={vi.fn()}
        onForkThread={vi.fn()}
        onSwitchThread={onSwitchThread}
      />,
    );

    // Open dropdown
    fireEvent.click(getByText("Thread 1"));

    // Click on main thread
    fireEvent.click(getByText("main"));
    expect(onSwitchThread).toHaveBeenCalledWith("thread-main");
  });

  it("shows checkpoint input when flag button is clicked", () => {
    const { getByTitle, getByPlaceholderText } = render(
      <ThreadIndicator
        threads={[mainThread]}
        activeThreadId="thread-main"
        onCreateCheckpoint={vi.fn()}
        onForkThread={vi.fn()}
        onSwitchThread={vi.fn()}
      />,
    );

    fireEvent.click(getByTitle("Create checkpoint"));
    expect(getByPlaceholderText("Checkpoint label (optional)")).toBeTruthy();
  });

  it("calls onCreateCheckpoint when saving", () => {
    const onCreateCheckpoint = vi.fn();
    const { getByTitle, getByPlaceholderText, getByText } = render(
      <ThreadIndicator
        threads={[mainThread]}
        activeThreadId="thread-main"
        onCreateCheckpoint={onCreateCheckpoint}
        onForkThread={vi.fn()}
        onSwitchThread={vi.fn()}
      />,
    );

    fireEvent.click(getByTitle("Create checkpoint"));
    const input = getByPlaceholderText("Checkpoint label (optional)");
    fireEvent.change(input, { target: { value: "My checkpoint" } });
    fireEvent.click(getByText("Save"));

    expect(onCreateCheckpoint).toHaveBeenCalledWith("My checkpoint");
  });

  it("calls onCreateCheckpoint with undefined when label is empty", () => {
    const onCreateCheckpoint = vi.fn();
    const { getByTitle, getByText } = render(
      <ThreadIndicator
        threads={[mainThread]}
        activeThreadId="thread-main"
        onCreateCheckpoint={onCreateCheckpoint}
        onForkThread={vi.fn()}
        onSwitchThread={vi.fn()}
      />,
    );

    fireEvent.click(getByTitle("Create checkpoint"));
    fireEvent.click(getByText("Save"));

    expect(onCreateCheckpoint).toHaveBeenCalledWith(undefined);
  });

  it("calls onCreateCheckpoint on Enter key", () => {
    const onCreateCheckpoint = vi.fn();
    const { getByTitle, getByPlaceholderText } = render(
      <ThreadIndicator
        threads={[mainThread]}
        activeThreadId="thread-main"
        onCreateCheckpoint={onCreateCheckpoint}
        onForkThread={vi.fn()}
        onSwitchThread={vi.fn()}
      />,
    );

    fireEvent.click(getByTitle("Create checkpoint"));
    const input = getByPlaceholderText("Checkpoint label (optional)");
    fireEvent.change(input, { target: { value: "test" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onCreateCheckpoint).toHaveBeenCalledWith("test");
  });

  it("closes checkpoint input on Escape", () => {
    const { getByTitle, getByPlaceholderText, queryByPlaceholderText } = render(
      <ThreadIndicator
        threads={[mainThread]}
        activeThreadId="thread-main"
        onCreateCheckpoint={vi.fn()}
        onForkThread={vi.fn()}
        onSwitchThread={vi.fn()}
      />,
    );

    fireEvent.click(getByTitle("Create checkpoint"));
    const input = getByPlaceholderText("Checkpoint label (optional)");
    fireEvent.keyDown(input, { key: "Escape" });

    expect(queryByPlaceholderText("Checkpoint label (optional)")).toBeNull();
  });

  it("shows checkpoints in dropdown", () => {
    const { getByText } = render(
      <ThreadIndicator
        threads={[threadWithCheckpoint]}
        activeThreadId="thread-main"
        onCreateCheckpoint={vi.fn()}
        onForkThread={vi.fn()}
        onSwitchThread={vi.fn()}
      />,
    );

    // Open dropdown
    fireEvent.click(getByText("main"));

    expect(getByText("Checkpoints")).toBeTruthy();
    expect(getByText("Before refactor")).toBeTruthy();
  });

  it("calls onForkThread when clicking fork button on checkpoint", () => {
    const onForkThread = vi.fn();
    const { getByText } = render(
      <ThreadIndicator
        threads={[threadWithCheckpoint]}
        activeThreadId="thread-main"
        onCreateCheckpoint={vi.fn()}
        onForkThread={onForkThread}
        onSwitchThread={vi.fn()}
      />,
    );

    // Open dropdown
    fireEvent.click(getByText("main"));

    // Click fork button on checkpoint
    fireEvent.click(getByText("fork"));

    expect(onForkThread).toHaveBeenCalledWith("cp-1");
  });

  it("shows thread count when multiple threads exist", () => {
    const { getByText } = render(
      <ThreadIndicator
        threads={[mainThread, secondThread]}
        activeThreadId="thread-main"
        onCreateCheckpoint={vi.fn()}
        onForkThread={vi.fn()}
        onSwitchThread={vi.fn()}
      />,
    );

    expect(getByText("(2)")).toBeTruthy();
  });

  it("disables buttons when disabled prop is true", () => {
    const { getByTitle } = render(
      <ThreadIndicator
        threads={[mainThread]}
        activeThreadId="thread-main"
        onCreateCheckpoint={vi.fn()}
        onForkThread={vi.fn()}
        onSwitchThread={vi.fn()}
        disabled
      />,
    );

    const cpButton = getByTitle("Create checkpoint");
    expect(cpButton).toBeDisabled();
  });
});
