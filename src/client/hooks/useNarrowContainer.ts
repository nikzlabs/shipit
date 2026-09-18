import { useLayoutEffect, useState, type RefObject } from "react";

export function useNarrowContainer(ref: RefObject<HTMLElement | null>, breakpointPx: number): boolean {
  const [narrow, setNarrow] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const w = el.clientWidth;

      if (w > 0) setNarrow(w < breakpointPx);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [ref, breakpointPx]);

  return narrow;
}
