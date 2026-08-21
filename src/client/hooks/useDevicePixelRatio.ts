import { useSyncExternalStore } from "react";

/**
 * The viewer's device pixel ratio, kept current as it changes.
 *
 * It changes more often than "high-DPI or not" suggests: dragging a window
 * between a Retina and a non-Retina display, browser zoom (which moves the ratio
 * in fractional steps), and OS display-scaling changes all move it while the
 * page stays mounted.
 *
 * `useSyncExternalStore` rather than `useState` + `useEffect` because that is
 * what this is — a value owned by the browser, read on demand, with a
 * subscription for invalidation. It also gives the right answer during SSR and
 * the first paint instead of rendering a default and correcting it after.
 *
 * The self-rearming listener below is the awkward part, and it is unavoidable:
 * there is no `devicePixelRatio` change event, so the only signal is a media
 * query pinned to *the current ratio*, which stops matching the moment the ratio
 * moves. So each firing has to build a fresh query for the new value.
 */
function subscribe(onStoreChange: () => void): () => void {
  let query: MediaQueryList | null = null;
  let disposed = false;

  const handler = (): void => {
    arm();
    onStoreChange();
  };

  function arm(): void {
    if (disposed) return;
    query?.removeEventListener("change", handler);
    query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    query.addEventListener("change", handler);
  }

  arm();
  return () => {
    disposed = true;
    query?.removeEventListener("change", handler);
  };
}

/** 1 is the honest fallback: no scaling correction, today's behavior. */
const FALLBACK_DPR = 1;

export function useDevicePixelRatio(): number {
  return useSyncExternalStore(
    subscribe,
    () => window.devicePixelRatio || FALLBACK_DPR,
    () => FALLBACK_DPR,
  );
}
