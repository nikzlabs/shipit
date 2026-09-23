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

  // planning#592 — jsdom computes no layout, so the focus scroll that blanked
  // the pane is unassertable; the row containing its own `sr-only` box is the
  // invariant that prevents it.
  it("keeps every row a containing block for its own hidden checkbox", () => {
    render(<Harness items={[item({ key: "a" }), item({ key: "b" })]} />);
    for (const box of screen.getAllByRole("checkbox")) {
      fireEvent.click(box);
      expect(box.className).toContain("sr-only");
      expect(box.closest("label")?.className.split(/\s+/)).toContain("relative");
    }
  });

  // docs/303 req 37 — the status card's per-step note needs a control beside
  // the row and a field under it, both outside the label.
  it("renders a trailing control outside the row's label", () => {
    render(
      <ActionChecklist
        items={[item({ key: "a", label: "Add the key" })]}
        selected={new Set()}
        onToggle={() => {}}
        ariaLabel="Offers"
        renderTrailing={(i) => <button type="button">note {i.key}</button>}
      />,
    );
    const control = screen.getByRole("button", { name: "note a" });
    expect(control.closest("label")).toBeNull();
  });

  it("renders content below the row, outside the label and inside the row", () => {
    render(
      <ActionChecklist
        items={[item({ key: "a" })]}
        selected={new Set(["a"])}
        onToggle={() => {}}
        ariaLabel="Offers"
        renderBelow={(i) => <textarea aria-label={`note ${i.key}`} />}
      />,
    );
    const field = screen.getByRole("textbox", { name: "note a" });
    expect(field.closest("label")).toBeNull();
    // Inside the ticked row's tint, so the note reads as part of the row.
    const row = screen.getByRole("checkbox").closest("label")!.parentElement!.parentElement!;
    expect(row.className).toContain("bg-(--color-accent-subtle)");
    expect(row.contains(field)).toBe(true);
  });

  it("renders neither when the caller supplies neither", () => {
    render(<Harness items={[item({ key: "a" })]} />);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows an item's tag beside its label, on a taken row as well", () => {
    const { rerender } = render(<Harness items={[item({ key: "a", tag: "ANSWERED" })]} />);
    expect(screen.getByText("ANSWERED")).toBeInTheDocument();
    expect(screen.queryByText("SENT")).not.toBeInTheDocument();

    // A row sent earlier that carries a NEW tag is pending; SENT alone denies it.
    rerender(<Harness items={[item({ key: "a", tag: "ANSWERED", taken: true })]} />);
    expect(screen.getByText("ANSWERED")).toBeInTheDocument();
    expect(screen.getByText("SENT")).toBeInTheDocument();
  });

  it("shows no tag when the item carries none", () => {
    render(<Harness items={[item({ key: "a" })]} />);
    expect(screen.queryByText("ANSWERED")).not.toBeInTheDocument();
  });

  // docs/303-session-status-card req 41
  describe("markdown", () => {
    it("renders a label and a description as markdown, not as their source", () => {
      render(
        <Harness
          items={[
            item({
              key: "a",
              label: "Merge the **billing** branch",
              description: "Runs `npm test` first",
            }),
          ]}
        />,
      );
      expect(screen.getByText("billing").tagName).toBe("STRONG");
      expect(screen.getByText("npm test").tagName).toBe("CODE");
      expect(screen.queryByText(/\*\*billing\*\*/)).not.toBeInTheDocument();
    });

    it("renders an external link with its href intact", () => {
      render(
        <Harness items={[item({ key: "a", label: "Read [the plan](https://example.com/p)" })]} />,
      );
      expect(screen.getByRole("link", { name: "the plan" })).toHaveAttribute(
        "href",
        "https://example.com/p",
      );
    });

    // A repo-file link and a ShipIt pointer are anchors with NO href, and the
    // spec does not count those as interactive content, so a <label> around one
    // forwards the click to its checkbox: opening a file would tick the row.
    // Measured in Chromium — `role` and `tabindex` do not help — and jsdom
    // counts tabindex, so it never forwards and cannot fail this. The DOM is
    // therefore where the browser's rule is asserted from, as for the note
    // control in SessionStatusCard.test.tsx.
    it("keeps the row's markdown text out of the label, so a link in it cannot tick the row", () => {
      render(<Harness items={[item({ key: "a", label: "Read [the plan](docs/303/plan.md)" })]} />);
      const link = screen.getByRole("button", { name: "the plan" });
      expect(link).not.toHaveAttribute("href");
      expect(link.closest("label")).toBeNull();

      fireEvent.click(link);
      expect(screen.getByTestId("selected")).toBeEmptyDOMElement();
      expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    });

    it("still ticks the row when the words beside the link are clicked", () => {
      render(
        <Harness items={[item({ key: "a", label: "Read [the plan](https://example.com/p) today" })]} />,
      );
      fireEvent.click(screen.getByText(/today/));
      expect(screen.getByTestId("selected")).toHaveTextContent(/^a$/);
    });

    it("leaves a link in a description clickable too, and outside the label", () => {
      render(
        <Harness
          items={[item({ key: "a", description: "See [the doc](https://example.com/d)" })]}
        />,
      );
      const link = screen.getByRole("link", { name: "the doc" });
      expect(link).toHaveAttribute("href", "https://example.com/d");
      expect(link.closest("label")).toBeNull();

      fireEvent.click(link);
      expect(screen.getByTestId("selected")).toBeEmptyDOMElement();
    });

    // Without `shipitLinks` the scheme is dropped and only the words survive,
    // so this is what says the rows opted in (docs/258).
    it("renders an agent-authored ShipIt pointer as a pointer, not as its words", () => {
      render(
        <Harness
          items={[item({ key: "a", label: "[Open settings](shipit-preview://web/settings)" })]}
        />,
      );
      expect(screen.getByRole("button", { name: "Open settings" })).toBeInTheDocument();
    });
  });
});
