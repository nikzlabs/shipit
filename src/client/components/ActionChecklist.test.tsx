import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import {
  ActionChecklist,
  useChecklistSelection,
  type ChecklistItem,
} from "./ActionChecklist.js";

function Harness({ items }: { items: readonly ChecklistItem[] }) {
  const { selected, toggle } = useChecklistSelection(items);
  return (
    <>
      <ActionChecklist items={items} selected={selected} onToggle={toggle} ariaLabel="Offers" />
      <span data-testid="selected">{[...selected].sort().join(",")}</span>
    </>
  );
}

const item = (over: Partial<ChecklistItem> & { key: string }): ChecklistItem => ({
  label: `Label ${over.key}`,
  ...over,
});

afterEach(() => cleanup());

describe("useChecklistSelection", () => {
  it("keys selection by the caller's key, not by anything on the item", () => {
    render(<Harness items={[item({ key: "offer-1" }), item({ key: "offer-2" })]} />);
    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    expect(screen.getByTestId("selected")).toHaveTextContent("offer-2");
  });

  it("applies defaultChecked the first time an item appears, and not again after it is unticked", () => {
    const items = [item({ key: "a", defaultChecked: true }), item({ key: "b" })];
    const { rerender } = render(<Harness items={items} />);
    expect(screen.getByTestId("selected")).toHaveTextContent("a");

    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    rerender(<Harness items={[...items]} />);
    expect(screen.getByTestId("selected")).toBeEmptyDOMElement();
  });

  it("applies defaultChecked to an item that replaces another, leaving the old key behind", () => {
    const { rerender } = render(<Harness items={[item({ key: "old" })]} />);
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    expect(screen.getByTestId("selected")).toHaveTextContent("old");

    rerender(<Harness items={[item({ key: "new", defaultChecked: true })]} />);
    expect(screen.getByTestId("selected")).toHaveTextContent(/^new$/);
  });

  it("drops a selected item from the selection once it is taken", () => {
    const { rerender } = render(<Harness items={[item({ key: "a" })]} />);
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    expect(screen.getByTestId("selected")).toHaveTextContent("a");

    rerender(<Harness items={[item({ key: "a", taken: true })]} />);
    expect(screen.getByTestId("selected")).toBeEmptyDOMElement();
  });

  it("never pre-ticks a taken item", () => {
    render(<Harness items={[item({ key: "a", defaultChecked: true, taken: true })]} />);
    expect(screen.getByTestId("selected")).toBeEmptyDOMElement();
  });
});

describe("ActionChecklist", () => {
  it("renders a taken item unchecked, disabled and greyed, with no RECOMMENDED badge", () => {
    render(
      <Harness items={[item({ key: "a", label: "Add retries", defaultChecked: true, taken: true })]} />,
    );
    const box = screen.getByRole("checkbox") as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(box).toBeDisabled();
    expect(screen.queryByText("RECOMMENDED")).not.toBeInTheDocument();
    expect(screen.getByText("Add retries").className).toContain("--color-text-tertiary");
  });

  it("keeps a taken item out of the selection however it is clicked", () => {
    render(<Harness items={[item({ key: "a", taken: true }), item({ key: "b" })]} />);
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    expect(screen.getByTestId("selected")).toBeEmptyDOMElement();
  });
});
