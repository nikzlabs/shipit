import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * Track whether a container element is narrower than `breakpointPx`, via a
 * `ResizeObserver` on the ref'd element (docs/206). The Issues panel ties its
 * collapse behavior to the SAME width that flips its row layout between the
 * table (`@sm`) and card layouts, so "narrow" here uses the container-query
 * `@sm` value (24rem / 384px) — when the panel is card-width it's "narrow".
 *
 * Returns `false` until measured (the safe desktop default), and stays `false`
 * where `ResizeObserver` is unavailable (e.g. jsdom without a stub), so a
 * component renders its wide layout rather than crashing. The element is assumed
 * to be mounted with the component (a `RefObject`, not a lazy callback ref).
 */
export function useNarrowContainer(ref: RefObject<HTMLElement | null>, breakpointPx: number): boolean {
  const [narrow, setNarrow] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const w = el.clientWidth;
      // Ignore a zero width (detached / display:none) so we don't flip to the
      // narrow layout spuriously before the panel has real dimensions.
      if (w > 0) setNarrow(w < breakpointPx);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [ref, breakpointPx]);

  return narrow;
}
