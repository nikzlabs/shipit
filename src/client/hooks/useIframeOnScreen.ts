/**
 * Tracks whether each pooled preview iframe **element** intersects the ShipIt
 * window's viewport.
 *
 * Why this exists (nikzlabs/shipit#2418). Chrome throttles rendering of a
 * cross-origin iframe whose element has no intersection with the embedder's
 * viewport: `requestAnimationFrame` in that document simply stops being called
 * until the element comes back. Measured against Chromium 141 with a
 * phone-shaped viewport — a host that scrolls or transforms the iframe out of
 * view withholds whole display periods from the page inside, while that page's
 * own signals all keep saying "showing": `document.hidden` stays false, its own
 * `IntersectionObserver` on its own content stays intersecting (it observes
 * against the iframe's viewport, which never moved), no `longtask` or
 * `long-animation-frame` entry is recorded (nothing is blocking — frames are
 * withheld, not slow), and `performance.memory` never changes.
 *
 * So the page cannot detect the condition from inside, and ShipIt's own
 * pane state cannot either: the slot is the active one and the panel is open,
 * which is all `PreviewFrame` used to consider before telling the page it was
 * visible. An `IntersectionObserver` on the iframe element, in the host
 * document, reads the same geometry the browser throttles on — so folding it
 * into the visibility message makes the stall observable to the page instead of
 * silent.
 *
 * Deliberately geometric only. `visibility: hidden` and `opacity: 0` are NOT
 * reported here (an `IntersectionObserver` ignores both, and — measured — the
 * browser does not throttle for either); ShipIt's own hiding of background
 * slots is already carried by the active-slot half of the visibility signal.
 */
// eslint-disable-next-line no-restricted-imports -- useEffect: tear down a browser observer on unmount (external system sync)
import { useEffect, useRef, useState } from "react";

export interface IframeOnScreenTracker {
  /**
   * Ref-callback companion: start (or stop, on `null`) observing the element
   * rendered for `key`. Safe to call on every render — re-observing the same
   * element for the same key is a no-op.
   */
  trackIframe: (key: string, el: HTMLIFrameElement | null) => void;
  /**
   * Slot keys whose iframe element is currently outside the viewport. A key is
   * absent until the observer has actually reported it off-screen, so the
   * default for an untracked or not-yet-reported slot is "on screen" — this
   * signal may only ever *remove* visibility, never grant it.
   */
  offScreenSlots: ReadonlySet<string>;
}

export function useIframeOnScreen(): IframeOnScreenTracker {
  const [offScreenSlots, setOffScreenSlots] = useState<ReadonlySet<string>>(() => new Set());
  // Both directions are needed: the observer callback resolves an element back
  // to its slot, and re-tracking a key has to unobserve the element it replaces.
  const keyForElement = useRef<Map<Element, string>>(new Map());
  const elementForKey = useRef<Map<string, HTMLIFrameElement>>(new Map());
  const observer = useRef<IntersectionObserver | null>(null);

  const markOffScreen = (key: string, off: boolean) => {
    setOffScreenSlots((prev) => {
      if (prev.has(key) === off) return prev;
      const next = new Set(prev);
      if (off) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const ensureObserver = (): IntersectionObserver | null => {
    if (observer.current) return observer.current;
    // jsdom and any non-browser host have no IntersectionObserver. Without one
    // every slot stays "on screen", which is exactly the pre-existing behavior.
    if (typeof IntersectionObserver !== "function") return null;
    observer.current = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const key = keyForElement.current.get(entry.target);
        if (key === undefined) continue;
        markOffScreen(key, !entry.isIntersecting);
      }
    });
    return observer.current;
  };

  const trackIframe = (key: string, el: HTMLIFrameElement | null) => {
    const previous = elementForKey.current.get(key);
    if (previous === (el ?? undefined)) return;
    if (previous) {
      observer.current?.unobserve(previous);
      keyForElement.current.delete(previous);
    }
    if (!el) {
      elementForKey.current.delete(key);
      // A slot with no element cannot be off-screen; leaving the key behind
      // would hold a recreated slot at `visible: false` until its first report.
      markOffScreen(key, false);
      return;
    }
    elementForKey.current.set(key, el);
    keyForElement.current.set(el, key);
    ensureObserver()?.observe(el);
  };

  // Unmounting detaches every iframe ref, so each element is unobserved on the
  // way out already — this closes the observer itself rather than leaving it for
  // the collector to notice along with the rest of the unmounted tree.
  // eslint-disable-next-line no-restricted-syntax -- tear down a browser observer on unmount
  useEffect(() => () => {
    observer.current?.disconnect();
    observer.current = null;
    keyForElement.current.clear();
    elementForKey.current.clear();
  }, []);

  return { trackIframe, offScreenSlots };
}
