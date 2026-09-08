import { createRef } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CompactLayout } from "./CompactLayout.js";

afterEach(cleanup);

it.each([true, false])("restores the pre-mutation anchor only when scroll guards permit it (%s)", (allowed) => {
  const root = createRef<HTMLDivElement>();
  const content = (hidden: boolean) => <div ref={root}><CompactLayout visibility={hidden ? "10" : "00"}
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

it("does no layout measurement on appends in the default full view", () => {
  const root = createRef<HTMLDivElement>();
  const content = (count: number) => <div ref={root}><CompactLayout visibility={"0".repeat(count)}
    containerRef={root} canRestoreReadingAnchor={() => true}>
    {Array.from({ length: count }, (_, i) => <div key={i} data-compact-content>Row {i}</div>)}
  </CompactLayout></div>;
  const { rerender } = render(content(1));
  const measure = vi.spyOn(root.current!, "getBoundingClientRect");
  rerender(content(2));
  expect(measure).not.toHaveBeenCalled();
});
