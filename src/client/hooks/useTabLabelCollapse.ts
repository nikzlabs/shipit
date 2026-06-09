import { useCallback, useLayoutEffect, useRef, type RefCallback } from "react";

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
 * Returns a **callback ref**, not a RefObject. This matters on mobile: the
 * right panel is mounted lazily (only while the Workspace tab is active), so a
 * `useEffect`/`useLayoutEffect` keyed on a stable dependency would run once at
 * the *parent's* mount — while the bar isn't in the tree and `ref.current` is
 * null — set up nothing, and never re-run when the bar later attaches. The bar
 * then stayed un-measured and the labels never collapsed (they just overflowed
 * off-screen). A callback ref fires exactly on attach/detach, so the
 * ResizeObserver is wired the moment the bar mounts regardless of when that is.
 *
 * `signature` must change whenever the set of visible tabs changes: a
 * width-only ResizeObserver won't fire when the panel keeps its width but a tab
 * appears or disappears, so we re-measure when the signature changes.
 */
export function useTabLabelCollapse(signature: string): RefCallback<HTMLElement> {
  const elRef = useRef<HTMLElement | null>(null);

  const measure = useCallback(() => {
    const el = elRef.current;
    if (!el) return;
    el.dataset.collapsed = "false";
    el.dataset.collapsed = el.scrollWidth > el.clientWidth + 1 ? "true" : "false";
  }, []);

  // Callback ref: observe the bar the instant it mounts and disconnect when it
  // unmounts. The cleanup return is supported by React 19 ref callbacks.
  const setRef = useCallback<RefCallback<HTMLElement>>(
    (node) => {
      elRef.current = node;
      if (!node) return;
      const observer = new ResizeObserver(measure);
      observer.observe(node);
      measure();
      return () => observer.disconnect();
    },
    [measure],
  );

  // Re-measure when the visible-tab signature changes (a width-only
  // ResizeObserver won't fire when the panel keeps its width but a tab
  // appears/disappears). No-op while the bar is unmounted.
  useLayoutEffect(measure, [signature, measure]);

  return setRef;
}
