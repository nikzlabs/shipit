import { createRef } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CompactLayout } from "./CompactLayout.js";

afterEach(cleanup);

it.each([true, false])("restores the pre-mutation anchor only when scroll guards permit it (%s)", (allowed) => {
  const root = createRef<HTMLDivElement>();
  const content = (hidden: boolean) => <div ref={root}><CompactLayout visibility={hidden ? "10" : "00"} cardAnchor={null} canPreserveAcrossCardMove={() => true}
    containerRef={root} canRestoreReadingAnchor={() => allowed}>
    <div data-compact-content hidden={hidden}>Detail</div>
    <div data-compact-content>Result</div>
  </CompactLayout></div>;
  const { rerender } = render(content(false));
  const detail = root.current!.children[0] as HTMLElement;
  const result = root.current!.children[1] as HTMLElement;
  result.getBoundingClientRect = () => new DOMRect(0, detail.hidden ? 20 : 120, 100, 40);
  root.current!.scrollTop = 200;
  rerender(content(true));
  expect(root.current!.scrollTop).toBe(allowed ? 100 : 200);
});

// docs/303-session-status-card req 30 — returning the card to the end takes it
// out from above a reader who has scrolled up, which would shift their row by
// the card's height. The visibility string does not change when it moves, and
// the guard is the card's own: the auto-follow flag can read true far from the
// bottom, where a restore is exactly what is needed.
it.each([true, false])("keeps the reader's row across the card's move only when its own guard permits it (%s)", (preserve) => {
  const root = createRef<HTMLDivElement>();
  const content = (cardAnchor: number | null) => <div ref={root}><CompactLayout visibility="00" cardAnchor={cardAnchor}
    canPreserveAcrossCardMove={() => preserve}
    containerRef={root} canRestoreReadingAnchor={() => !preserve}>
    {cardAnchor === null ? null : <div key="card" data-status-card>Card</div>}
    <div key="a" data-compact-content>Detail</div>
    <div key="b" data-compact-content>Result</div>
  </CompactLayout></div>;
  const { rerender } = render(content(1));
  const detail = root.current!.querySelector<HTMLElement>("[data-compact-content]")!;
  detail.getBoundingClientRect = () =>
    new DOMRect(0, root.current!.querySelector("[data-status-card]") ? 120 : 60, 100, 40);
  root.current!.scrollTop = 200;
  rerender(content(null));
  expect(root.current!.scrollTop).toBe(preserve ? 140 : 200);
});

// docs/303 req 30 — the card's boundary splits a row group, so the rows under
// it change DOM parent and React remounts them. The anchor the snapshot
// measured is one of those, so a restore that holds the node alone finds it
// disconnected and silently does nothing. Caught in the dogfood instance.
it("re-finds the anchor row when the reflow remounted it", () => {
  const root = createRef<HTMLDivElement>();
  const content = (cardAnchor: number | null) => <div ref={root}><CompactLayout visibility="00" cardAnchor={cardAnchor}
    canPreserveAcrossCardMove={() => true}
    containerRef={root} canRestoreReadingAnchor={() => false}>
    {cardAnchor === null ? null : <div key="card" data-status-card>Card</div>}
    {/* The key changes with the anchor, as a row changing group does. */}
    <div key={`a-${cardAnchor}`} id="compact-row-0" data-compact-content>Detail</div>
    <div key="b" id="compact-row-1" data-compact-content>Result</div>
  </CompactLayout></div>;
  // Patched on the prototype, so the row React mounts in place of the measured
  // one reports the position the card's departure gives it.
  const original = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.id !== "compact-row-0") return original.call(this);
    return new DOMRect(0, root.current!.querySelector("[data-status-card]") ? 120 : 60, 100, 40);
  };
  try {
    const { rerender } = render(content(1));
    root.current!.scrollTop = 200;
    rerender(content(null));
    expect(root.current!.scrollTop).toBe(140);
  } finally {
    HTMLElement.prototype.getBoundingClientRect = original;
  }
});

it("does no layout measurement on appends in the default full view", () => {
  const root = createRef<HTMLDivElement>();
  const content = (count: number) => <div ref={root}><CompactLayout visibility={"0".repeat(count)} cardAnchor={null} canPreserveAcrossCardMove={() => true}
    containerRef={root} canRestoreReadingAnchor={() => true}>
    {Array.from({ length: count }, (_, i) => <div key={i} data-compact-content>Row {i}</div>)}
  </CompactLayout></div>;
  const { rerender } = render(content(1));
  const measure = vi.spyOn(root.current!, "getBoundingClientRect");
  rerender(content(2));
  expect(measure).not.toHaveBeenCalled();
});
