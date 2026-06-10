import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IssuePriorityEditor, IssueStatusEditor } from "./IssueFieldControls.js";

/**
 * Tests for the inline status / priority editors (docs/191): they open a
 * single-select menu, fire the async write with the chosen value, no-op on
 * re-picking the current value, and degrade to a read-only trigger when there
 * are no options to choose from.
 */

afterEach(() => cleanup());

describe("IssueStatusEditor", () => {
  const OPTIONS = [
    { name: "Todo", type: "unstarted" },
    { name: "In Progress", type: "started" },
    { name: "Done", type: "completed" },
  ];

  it("opens the menu and fires onSelect with the chosen status name", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn(async () => null as string | null);
    render(
      <IssueStatusEditor
        current={{ name: "In Progress", type: "started" }}
        options={OPTIONS}
        onSelect={onSelect}
        ariaLabel="Change status"
        trigger={<span>In Progress</span>}
      />,
    );
    await user.click(screen.getByLabelText("Change status"));
    await user.click(screen.getByRole("menuitem", { name: "Done" }));
    expect(onSelect).toHaveBeenCalledWith("Done");
  });

  it("does not fire onSelect when re-picking the current status", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn(async () => null as string | null);
    render(
      <IssueStatusEditor
        current={{ name: "In Progress", type: "started" }}
        options={OPTIONS}
        onSelect={onSelect}
        ariaLabel="Change status"
        trigger={<span>In Progress</span>}
      />,
    );
    await user.click(screen.getByLabelText("Change status"));
    await user.click(screen.getByRole("menuitem", { name: "In Progress" }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("renders the trigger read-only when there are no options", () => {
    render(
      <IssueStatusEditor
        current={{ name: "In Progress" }}
        options={[]}
        onSelect={vi.fn()}
        ariaLabel="Change status"
        trigger={<span>In Progress</span>}
      />,
    );
    expect(screen.queryByLabelText("Change status")).toBeNull();
    expect(screen.getByText("In Progress")).toBeInTheDocument();
  });
});

describe("IssuePriorityEditor", () => {
  it("fires onSelect with the normalized level", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn(async () => null as string | null);
    render(
      <IssuePriorityEditor
        current="low"
        onSelect={onSelect}
        ariaLabel="Change priority"
        trigger={<span>Low</span>}
      />,
    );
    await user.click(screen.getByLabelText("Change priority"));
    await user.click(screen.getByRole("menuitem", { name: "High" }));
    expect(onSelect).toHaveBeenCalledWith("high");
  });
});
