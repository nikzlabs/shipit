import { useLayoutEffect, useRef } from "react";

/**
 * Drives the right-panel tab bar's icon-only collapse by measuring *real*
 * overflow rather than a fixed width breakpoint, so the threshold adapts to
 * however many tabs happen to be visible (Preview/Present/PR/Host all come and
 * go). The hook owns a `data-collapsed` attribute on the bar imperatively; the
 * Tab labels hide via `group-data-[collapsed=true]/tabs:hidden`.
 *
 * Measurement trick: before reading `scrollWidth` we force `data-collapsed`
 * back to "false" so the labels are laid out, read the intrinsic width, then
 * set the real value. Reading `scrollWidth` forces a synchronous reflow, so the
 * intermediate expanded state is measured but never painted — no flicker. The
 * `flex-1` spacer in the bar shrinks to zero first, so `scrollWidth` only
 * exceeds `clientWidth` once the tabs themselves genuinely don't fit.
 *
 * `signature` must change whenever the set of visible tabs changes: a
 * width-only ResizeObserver won't fire when the panel keeps its width but a tab
 * appears or disappears, so we re-measure when the signature changes.
 */
export function useTabLabelCollapse<T extends HTMLElement>(signature: string) {
  const ref = useRef<T>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      el.dataset.collapsed = "false";
      const overflowing = el.scrollWidth > el.clientWidth + 1;
      el.dataset.collapsed = overflowing ? "true" : "false";
    };

    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, [signature]);

  return ref;
}
