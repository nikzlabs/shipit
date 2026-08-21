import { useCallback, useLayoutEffect, useRef, type RefCallback } from "react";

/**
 * How much of the address the toolbar protects before it starts dropping
 * labels, in CSS pixels. This is the whole tuning surface of the collapse: it
 * decides how early labels give way. At 130px the first label goes at a panel
 * width of roughly 680px — about a half-width split pane — and the address
 * stays readable ("/requirements?f…") the whole way down to there.
 */
export const ADDRESS_MIN_PX = 130;

/** Marks the element whose width the collapse protects (PreviewPath's text). */
export const ADDRESS_MEASURE_ATTR = "data-preview-address";

/**
 * Labels in the order they are given up. Each entry names the `data-*` flag the
 * toolbar reads to hide that label, and the order IS the priority: the viewport
 * label goes first because the device icon still carries the meaning, then
 * Auto-fix because the toggle's colour already reports its state, and the
 * service name last because it is the only label that says *what you are
 * looking at*.
 */
const STAGES = ["hideViewport", "hideAutofix", "hideService"] as const;

export const MAX_COLLAPSE_STAGE = STAGES.length;

/** What one probe of the laid-out toolbar reports back. */
export interface CollapseProbe {
  /** The row's content is wider than the row. */
  overflows: boolean;
  /** Current width of the address text, or null when no address is shown. */
  addressWidth: number | null;
  /**
   * Whether the address is cut short — it wants more width than it has.
   *
   * Width alone cannot answer "is the address being squeezed", because the
   * measured element is content-sized: `/` measures a few pixels in a 1200px
   * toolbar exactly as it does in a 320px one. Testing width alone therefore
   * read every short URL as starved and collapsed the whole bar at any width,
   * which is the common case rather than an edge one.
   */
  addressTruncated: boolean;
}

/**
 * Decides how many labels to give up, and it is the priority rule of the whole
 * toolbar: **the address outranks every label.**
 *
 * A stage is spent for either reason, and the first one is what makes labels
 * yield *before* the address does:
 *
 *   1. the address is under its minimum — drop a label to hand it that width;
 *   2. the row overflows outright — drop a label because nothing else fits.
 *
 * `apply` must lay the toolbar out at the given stage before `probe` is called,
 * so each pass sees the width the previous stage actually freed. When the
 * stages run out the caller does nothing further: the address then shrinks on
 * its own, through CSS, and is never hidden. That is deliberate — a hidden
 * address leaves a visible gap next to the copy button, which reads as the
 * layout having given up early rather than having run out of room.
 */
export function resolveCollapseStage(
  addressMin: number,
  apply: (stage: number) => void,
  probe: () => CollapseProbe,
  maxStage: number = MAX_COLLAPSE_STAGE,
): number {
  let stage = 0;
  apply(stage);
  while (stage < maxStage) {
    const { overflows, addressWidth, addressTruncated } = probe();
    // Starved means "cut short AND still under its minimum" — both halves are
    // load-bearing. Truncation alone is not starvation: a genuinely long URL
    // stays truncated no matter how much room it gets, and would spend every
    // stage for nothing. Width alone is not starvation either, because a short
    // path is narrow by nature rather than by pressure. The half-pixel of slack
    // keeps sub-pixel layout from spending a stage that buys nothing.
    const starved =
      addressTruncated && addressWidth !== null && addressWidth < addressMin - 0.5;
    if (!overflows && !starved) break;
    stage += 1;
    apply(stage);
  }
  return stage;
}

/** Writes the stage onto the toolbar as the flags the labels hide off. */
function applyStage(el: HTMLElement, stage: number): void {
  STAGES.forEach((flag, index) => {
    el.dataset[flag] = stage > index ? "true" : "false";
  });
}

/**
 * Collapses the preview toolbar's labels to icons as the panel narrows, by
 * measuring real widths rather than by a viewport breakpoint. The breakpoint
 * would be wrong here in both directions: the preview is a split pane on
 * desktop, so it overflows at desktop widths too, and a phone in landscape has
 * room a `max-width` rule would deny it. Same mechanism as
 * `useTabLabelCollapse`, extended from one boolean to a priority ladder.
 *
 * Returns a **callback ref** for the same reason that hook does: the right
 * panel mounts lazily on mobile, so an effect keyed on a stable dependency
 * would run while the bar is not in the tree and never wire anything up.
 *
 * `signature` must change whenever the bar's intrinsic width changes without
 * its own width changing — a longer service name, the error badge appearing —
 * since a ResizeObserver alone would not fire for those.
 */
export function usePreviewToolbarCollapse(
  signature: string,
  addressMin: number = ADDRESS_MIN_PX,
): RefCallback<HTMLElement> {
  const elRef = useRef<HTMLElement | null>(null);

  const measure = useCallback(() => {
    const el = elRef.current;
    if (!el) return;
    // No layout yet — an unmounted panel, a display:none ancestor, or jsdom.
    // Measuring here would read every width as 0, conclude the address is
    // starved and collapse the bar completely, so leave it fully expanded.
    if (el.clientWidth === 0) return;

    resolveCollapseStage(
      addressMin,
      (stage) => applyStage(el, stage),
      () => {
        // Reading these forces a synchronous reflow, so the next pass sees the
        // effect of the stage just applied. The intermediate states are
        // measured but never painted, so there is no flicker.
        const overflows = el.scrollWidth > el.clientWidth + 1;
        const address = el.querySelector<HTMLElement>(`[${ADDRESS_MEASURE_ATTR}]`);
        return {
          overflows,
          addressWidth: address ? address.getBoundingClientRect().width : null,
          // The route and query each carry `truncate`, so a clipped one reports
          // scrollWidth past its clientWidth. Asking the children rather than
          // the wrapper matters: the wrapper's own overflow is hidden and its
          // children shrink to fit inside it, so the wrapper always looks full.
          addressTruncated: address
            ? Array.from(address.children).some(
                (child) => child.scrollWidth > child.clientWidth + 1,
              )
            : false,
        };
      },
    );
  }, [addressMin]);

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

  useLayoutEffect(measure, [signature, measure]);

  return setRef;
}
