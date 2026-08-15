import { describe, it, expect, afterEach, vi } from "vitest";
import { memo } from "react";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import { RowHandlersProvider, useRowHandlers, type RowHandlers } from "./row-context.js";

/**
 * planning#375 — the stale-closure trap this context exists to avoid.
 *
 * A memoized row renders its children with these callbacks and then, by design,
 * may never render again. If the context handed out the callback belonging to
 * the render that happened to be current when the row last drew, that row would
 * keep calling a dead closure forever — stable identity bought with a
 * correctness bug. The wrappers have to be stable AND current.
 */
afterEach(cleanup);

let renderCount = 0;
const Row = memo(() => {
  renderCount++;
  const handlers = useRowHandlers();
  return (
    <>
      <button onClick={() => handlers.onSendFollowUp?.("hi")}>send</button>
      <span data-testid="has-undo">{handlers.onUndoIssueWrite ? "yes" : "no"}</span>
    </>
  );
});
Row.displayName = "Row";

function base(overrides: Partial<RowHandlers> = {}): RowHandlers {
  return { messages: [], findPlanContent: () => undefined, ...overrides };
}

describe("RowHandlersProvider", () => {
  it("calls the LATEST callback from a row that never re-rendered", () => {
    const first = vi.fn(() => true);
    const { rerender } = render(
      <RowHandlersProvider value={base({ onSendFollowUp: first })}><Row /></RowHandlersProvider>,
    );
    expect(renderCount).toBe(1);

    const second = vi.fn(() => true);
    rerender(
      <RowHandlersProvider value={base({ onSendFollowUp: second })}><Row /></RowHandlersProvider>,
    );
    // The row bailed out — which is the whole point…
    expect(renderCount).toBe(1);

    fireEvent.click(screen.getByText("send"));
    // …and it still reached the current handler, not the one it rendered with.
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("hi");
  });

  it("reports a handler the parent did not pass as absent", () => {
    // Several cards gate a control on whether its handler EXISTS. Flattening
    // every callback to an always-defined wrapper would draw buttons that do
    // nothing, so optionality has to survive the indirection.
    render(<RowHandlersProvider value={base()}><Row /></RowHandlersProvider>);
    expect(screen.getByTestId("has-undo")).toHaveTextContent("no");
  });

  it("reports a handler the parent did pass as present", () => {
    render(
      <RowHandlersProvider value={base({ onUndoIssueWrite: () => {} })}><Row /></RowHandlersProvider>,
    );
    expect(screen.getByTestId("has-undo")).toHaveTextContent("yes");
  });

  it("hands out the same function identity across renders", () => {
    const seen: unknown[] = [];
    const Probe = () => { seen.push(useRowHandlers().onSendFollowUp); return null; };
    const { rerender } = render(
      <RowHandlersProvider value={base({ onSendFollowUp: () => true })}><Probe /></RowHandlersProvider>,
    );
    rerender(
      <RowHandlersProvider value={base({ onSendFollowUp: () => true })}><Probe /></RowHandlersProvider>,
    );
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
  });

  it("reads the live messages array", () => {
    const Probe = () => <span data-testid="n">{useRowHandlers().messages.length}</span>;
    const { rerender } = render(
      <RowHandlersProvider value={base({ messages: [] })}><Probe /></RowHandlersProvider>,
    );
    expect(screen.getByTestId("n")).toHaveTextContent("0");
    rerender(
      <RowHandlersProvider value={base({ messages: [{ role: "user", text: "a" }] })}><Probe /></RowHandlersProvider>,
    );
    expect(screen.getByTestId("n")).toHaveTextContent("1");
  });
});
