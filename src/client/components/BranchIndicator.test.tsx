import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { BranchIndicator, type BranchInfo } from "./BranchIndicator.js";

afterEach(cleanup);

const mainBranch: BranchInfo = {
  id: "branch-main",
  sessionId: "session-1",
  parentCheckpointId: null,
  name: "main",
  checkpoints: [],
  isActive: true,
  createdAt: new Date().toISOString(),
};

const branchWithCheckpoint: BranchInfo = {
  id: "branch-main",
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

const secondBranch: BranchInfo = {
  id: "branch-2",
  sessionId: "session-1",
  parentCheckpointId: "cp-1",
  name: "Branch 1",
  checkpoints: [],
  isActive: false,
  createdAt: new Date().toISOString(),
};

describe("BranchIndicator", () => {
  it("renders nothing when no branches", () => {
    const { container } = render(
      <BranchIndicator
        branches={[]}
        activeBranchId=""
        onCreateCheckpoint={vi.fn()}
        onBranchFromCheckpoint={vi.fn()}
        onSwitchBranch={vi.fn()}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("shows active branch name", () => {
    const { getByText } = render(
      <BranchIndicator
        branches={[mainBranch]}
        activeBranchId="branch-main"
        onCreateCheckpoint={vi.fn()}
        onBranchFromCheckpoint={vi.fn()}
        onSwitchBranch={vi.fn()}
      />,
    );
    expect(getByText("main")).toBeTruthy();
  });

  it("opens dropdown on click", () => {
    const { getByText, queryByText } = render(
      <BranchIndicator
        branches={[mainBranch]}
        activeBranchId="branch-main"
        onCreateCheckpoint={vi.fn()}
        onBranchFromCheckpoint={vi.fn()}
        onSwitchBranch={vi.fn()}
      />,
    );

    // Dropdown content not visible initially
    expect(queryByText("Branches")).toBeNull();

    // Click to open
    fireEvent.click(getByText("main"));
    expect(getByText("Branches")).toBeTruthy();
  });

  it("calls onSwitchBranch when clicking another branch", () => {
    const onSwitchBranch = vi.fn();
    const { getByText } = render(
      <BranchIndicator
        branches={[{ ...mainBranch, isActive: false }, { ...secondBranch, isActive: true }]}
        activeBranchId="branch-2"
        onCreateCheckpoint={vi.fn()}
        onBranchFromCheckpoint={vi.fn()}
        onSwitchBranch={onSwitchBranch}
      />,
    );

    // Open dropdown
    fireEvent.click(getByText("Branch 1"));

    // Click on main branch
    fireEvent.click(getByText("main"));
    expect(onSwitchBranch).toHaveBeenCalledWith("branch-main");
  });

  it("shows checkpoint input when flag button is clicked", () => {
    const { getByTitle, getByPlaceholderText } = render(
      <BranchIndicator
        branches={[mainBranch]}
        activeBranchId="branch-main"
        onCreateCheckpoint={vi.fn()}
        onBranchFromCheckpoint={vi.fn()}
        onSwitchBranch={vi.fn()}
      />,
    );

    fireEvent.click(getByTitle("Create checkpoint"));
    expect(getByPlaceholderText("Checkpoint label (optional)")).toBeTruthy();
  });

  it("calls onCreateCheckpoint when saving", () => {
    const onCreateCheckpoint = vi.fn();
    const { getByTitle, getByPlaceholderText, getByText } = render(
      <BranchIndicator
        branches={[mainBranch]}
        activeBranchId="branch-main"
        onCreateCheckpoint={onCreateCheckpoint}
        onBranchFromCheckpoint={vi.fn()}
        onSwitchBranch={vi.fn()}
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
      <BranchIndicator
        branches={[mainBranch]}
        activeBranchId="branch-main"
        onCreateCheckpoint={onCreateCheckpoint}
        onBranchFromCheckpoint={vi.fn()}
        onSwitchBranch={vi.fn()}
      />,
    );

    fireEvent.click(getByTitle("Create checkpoint"));
    fireEvent.click(getByText("Save"));

    expect(onCreateCheckpoint).toHaveBeenCalledWith(undefined);
  });

  it("calls onCreateCheckpoint on Enter key", () => {
    const onCreateCheckpoint = vi.fn();
    const { getByTitle, getByPlaceholderText } = render(
      <BranchIndicator
        branches={[mainBranch]}
        activeBranchId="branch-main"
        onCreateCheckpoint={onCreateCheckpoint}
        onBranchFromCheckpoint={vi.fn()}
        onSwitchBranch={vi.fn()}
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
      <BranchIndicator
        branches={[mainBranch]}
        activeBranchId="branch-main"
        onCreateCheckpoint={vi.fn()}
        onBranchFromCheckpoint={vi.fn()}
        onSwitchBranch={vi.fn()}
      />,
    );

    fireEvent.click(getByTitle("Create checkpoint"));
    const input = getByPlaceholderText("Checkpoint label (optional)");
    fireEvent.keyDown(input, { key: "Escape" });

    expect(queryByPlaceholderText("Checkpoint label (optional)")).toBeNull();
  });

  it("shows checkpoints in dropdown", () => {
    const { getByText } = render(
      <BranchIndicator
        branches={[branchWithCheckpoint]}
        activeBranchId="branch-main"
        onCreateCheckpoint={vi.fn()}
        onBranchFromCheckpoint={vi.fn()}
        onSwitchBranch={vi.fn()}
      />,
    );

    // Open dropdown
    fireEvent.click(getByText("main"));

    expect(getByText("Checkpoints")).toBeTruthy();
    expect(getByText("Before refactor")).toBeTruthy();
  });

  it("calls onBranchFromCheckpoint when clicking branch button on checkpoint", () => {
    const onBranchFromCheckpoint = vi.fn();
    const { getByText } = render(
      <BranchIndicator
        branches={[branchWithCheckpoint]}
        activeBranchId="branch-main"
        onCreateCheckpoint={vi.fn()}
        onBranchFromCheckpoint={onBranchFromCheckpoint}
        onSwitchBranch={vi.fn()}
      />,
    );

    // Open dropdown
    fireEvent.click(getByText("main"));

    // Click branch button on checkpoint
    fireEvent.click(getByText("branch"));

    expect(onBranchFromCheckpoint).toHaveBeenCalledWith("cp-1");
  });

  it("shows branch count when multiple branches exist", () => {
    const { getByText } = render(
      <BranchIndicator
        branches={[mainBranch, secondBranch]}
        activeBranchId="branch-main"
        onCreateCheckpoint={vi.fn()}
        onBranchFromCheckpoint={vi.fn()}
        onSwitchBranch={vi.fn()}
      />,
    );

    expect(getByText("(2)")).toBeTruthy();
  });

  it("disables buttons when disabled prop is true", () => {
    const { getByTitle } = render(
      <BranchIndicator
        branches={[mainBranch]}
        activeBranchId="branch-main"
        onCreateCheckpoint={vi.fn()}
        onBranchFromCheckpoint={vi.fn()}
        onSwitchBranch={vi.fn()}
        disabled
      />,
    );

    const cpButton = getByTitle("Create checkpoint");
    expect(cpButton).toBeDisabled();
  });
});
