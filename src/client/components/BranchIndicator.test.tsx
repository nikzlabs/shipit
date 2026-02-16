import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { BranchIndicator } from "./BranchIndicator.js";

afterEach(cleanup);

describe("BranchIndicator", () => {
  const branches = [
    { id: "b1", name: "main", sessionId: "", checkpoints: [], isActive: true, createdAt: new Date().toISOString() },
    { id: "b2", name: "experiment", sessionId: "", checkpoints: [], isActive: false, createdAt: new Date().toISOString() },
  ];

  it("renders branch options", () => {
    render(
      <BranchIndicator
        branches={branches}
        activeBranchId="b1"
        onSwitchBranch={() => {}}
        onCreateCheckpoint={() => {}}
      />,
    );

    expect(screen.getByLabelText("Active branch")).toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.getByText("experiment")).toBeInTheDocument();
  });

  it("calls onSwitchBranch when selection changes", () => {
    const onSwitch = vi.fn();
    render(
      <BranchIndicator
        branches={branches}
        activeBranchId="b1"
        onSwitchBranch={onSwitch}
        onCreateCheckpoint={() => {}}
      />,
    );

    fireEvent.change(screen.getByLabelText("Active branch"), { target: { value: "b2" } });
    expect(onSwitch).toHaveBeenCalledWith("b2");
  });

  it("calls onCreateCheckpoint when button is clicked", () => {
    const onCreate = vi.fn();
    render(
      <BranchIndicator
        branches={branches}
        activeBranchId="b1"
        onSwitchBranch={() => {}}
        onCreateCheckpoint={onCreate}
      />,
    );

    fireEvent.click(screen.getByText("Checkpoint"));
    expect(onCreate).toHaveBeenCalledOnce();
  });
});
