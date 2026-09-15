import { StrictMode } from "react";
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
    const items = () => [item({ key: "a", defaultChecked: true }), item({ key: "b" })];
    const { rerender } = render(<Harness items={items()} />);
    expect(screen.getByTestId("selected")).toHaveTextContent("a");

    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    rerender(<Harness items={items()} />);
    expect(screen.getByTestId("selected")).toBeEmptyDOMElement();
  });

  it("keeps a ticked item ticked while its neighbours arrive and leave", () => {
    const a = () => item({ key: "a" });
    const { rerender } = render(<Harness items={[a(), item({ key: "b" })]} />);
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    expect(screen.getByTestId("selected")).toHaveTextContent(/^a$/);

    rerender(<Harness items={[a(), item({ key: "b" }), item({ key: "c" })]} />);
    expect(screen.getByTestId("selected")).toHaveTextContent(/^a$/);

    rerender(<Harness items={[a()]} />);
    expect(screen.getByTestId("selected")).toHaveTextContent(/^a$/);
  });

  it("applies defaultChecked to an item that replaces another, leaving the old key behind", () => {
    const { rerender } = render(<Harness items={[item({ key: "old" })]} />);
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    expect(screen.getByTestId("selected")).toHaveTextContent("old");

    rerender(<Harness items={[item({ key: "new", defaultChecked: true })]} />);
    expect(screen.getByTestId("selected")).toHaveTextContent(/^new$/);
  });

  it("applies defaults once under StrictMode's double render", () => {
    render(
      <StrictMode>
        <Harness items={[item({ key: "a", defaultChecked: true })]} />
      </StrictMode>,
    );
    expect(screen.getByTestId("selected")).toHaveTextContent(/^a$/);
  });

  it("treats a key that leaves and returns as arriving anew", () => {
    const back = [item({ key: "a", defaultChecked: true })];
    const { rerender } = render(<Harness items={back} />);
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    expect(screen.getByTestId("selected")).toBeEmptyDOMElement();

    rerender(<Harness items={[item({ key: "b" })]} />);
    rerender(<Harness items={back} />);
    expect(screen.getByTestId("selected")).toHaveTextContent(/^a$/);
  });

  it("keeps a selected item selected when it becomes taken — sending it again is the user's call", () => {
    const { rerender } = render(<Harness items={[item({ key: "a" })]} />);
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    expect(screen.getByTestId("selected")).toHaveTextContent("a");

    rerender(<Harness items={[item({ key: "a", taken: true })]} />);
    expect(screen.getByTestId("selected")).toHaveTextContent("a");
  });

  it("never pre-ticks a taken item", () => {
    render(<Harness items={[item({ key: "a", defaultChecked: true, taken: true })]} />);
    expect(screen.getByTestId("selected")).toBeEmptyDOMElement();
  });
});

describe("ActionChecklist", () => {
  it("shows a taken item as the caller has it: ticked again means send it again", () => {
    render(
      <ActionChecklist
        items={[item({ key: "a", taken: true })]}
        selected={new Set(["a"])}
        onToggle={() => {}}
        ariaLabel="Offers"
      />,
    );
    const box = screen.getByRole("checkbox") as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(box).not.toBeDisabled();
  });

  it("labels a taken item SENT, so its grey is not a mystery", () => {
    render(<Harness items={[item({ key: "a", taken: true })]} />);
    expect(screen.getByText("SENT")).toBeInTheDocument();
  });

  it("leaves an untaken item unlabelled", () => {
    render(<Harness items={[item({ key: "a" })]} />);
    expect(screen.queryByText("SENT")).not.toBeInTheDocument();
  });

  it("renders a taken item greyed and not pre-ticked, with no RECOMMENDED badge", () => {
    render(
      <Harness items={[item({ key: "a", label: "Add retries", defaultChecked: true, taken: true })]} />,
    );
    const box = screen.getByRole("checkbox") as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.queryByText("RECOMMENDED")).not.toBeInTheDocument();
    expect(screen.getByText("Add retries").className).toContain("--color-text-tertiary");
  });

  it("lets the user tick a taken item again, so a crashed or ignored one can be re-sent", () => {
    render(<Harness items={[item({ key: "a", taken: true }), item({ key: "b" })]} />);
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    expect(screen.getByTestId("selected")).toHaveTextContent("a");
  });
});
