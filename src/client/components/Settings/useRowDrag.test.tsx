/**
 * docs/252 req 21 — the fallback order is changed by dragging a row.
 *
 * The order is not cosmetic: the FIRST credential of a group is the one
 * delivered, so a drop that reports the wrong order changes which key sessions
 * authenticate with. That is what these assert — the array handed back, not the
 * CSS.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { useRowDrag } from "./useRowDrag.js";

afterEach(() => cleanup());

/** A list of grips and rows, wired exactly as a credential row wires them. */
function Rows({ ids, onReorder, disabled }: { ids: string[]; onReorder: (next: string[]) => void; disabled?: boolean }) {
  const dragFor = useRowDrag(ids, onReorder, disabled);
  return (
    <div>
      {ids.map((id) => {
        const drag = dragFor(id);
        return (
          <div key={id} {...(drag?.container ?? {})} data-testid={`row-${id}`} data-over={drag?.isOver}>
            {drag && <span {...drag.handle} data-testid={`grip-${id}`}>grip</span>}
          </div>
        );
      })}
    </div>
  );
}

// jsdom fires no drag sequence of its own, so the three events the hook listens
// for are dispatched by hand. `dragOver` is not ceremony: without its
// `preventDefault` a real browser refuses the drop and never fires `drop` at
// all, so a test that skipped it would pass over a control that cannot work.
function drag(sourceId: string, targetId: string) {
  const dataTransfer = { effectAllowed: "", setData: () => {}, getData: () => sourceId };
  fireEvent.dragStart(screen.getByTestId(`grip-${sourceId}`), { dataTransfer });
  const target = screen.getByTestId(`row-${targetId}`);
  fireEvent.dragOver(target, { dataTransfer });
  fireEvent.drop(target, { dataTransfer });
}

describe("useRowDrag", () => {
  it("hands back the complete new order, not a move-one verb", () => {
    // The reorder endpoint rejects a partial list on purpose (docs/150 req 2):
    // a stale client — one whose list predates a credential added in another
    // tab — must fail loudly instead of silently demoting it to the end.
    const onReorder = vi.fn();
    render(<Rows ids={["a", "b", "c"]} onReorder={onReorder} />);

    drag("c", "a");

    expect(onReorder).toHaveBeenCalledWith(["c", "a", "b"]);
  });

  it("moves a row down as readily as up", () => {
    const onReorder = vi.fn();
    render(<Rows ids={["a", "b", "c"]} onReorder={onReorder} />);

    drag("a", "c");

    expect(onReorder).toHaveBeenCalledWith(["b", "c", "a"]);
  });

  it("says nothing when a row is dropped on itself", () => {
    const onReorder = vi.fn();
    render(<Rows ids={["a", "b"]} onReorder={onReorder} />);

    drag("a", "a");

    expect(onReorder).not.toHaveBeenCalled();
  });

  it("offers no grip at all below two rows, where there is no order to change", () => {
    render(<Rows ids={["a"]} onReorder={vi.fn()} />);
    expect(screen.queryByTestId("grip-a")).toBeNull();
  });

  it("offers no grip while a previous drop is still in flight", () => {
    render(<Rows ids={["a", "b"]} onReorder={vi.fn()} disabled />);
    expect(screen.queryByTestId("grip-a")).toBeNull();
  });

  it("marks the row under the pointer, and only while a drag is live", () => {
    render(<Rows ids={["a", "b"]} onReorder={vi.fn()} />);
    const target = screen.getByTestId("row-b");
    const dataTransfer = { effectAllowed: "", setData: () => {}, getData: () => "a" };

    // No drag started: hovering a row must not light it up.
    fireEvent.dragOver(target, { dataTransfer });
    expect(target.getAttribute("data-over")).toBe("false");

    fireEvent.dragStart(screen.getByTestId("grip-a"), { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer });
    expect(target.getAttribute("data-over")).toBe("true");

    fireEvent.dragEnd(screen.getByTestId("grip-a"));
    expect(target.getAttribute("data-over")).toBe("false");
  });
});
