// eslint-disable-next-line no-restricted-imports -- useEffect: window.matchMedia listener with cleanup (browser API subscription)
import { useState, useEffect } from "react";

/**
 * Hook that tracks whether a CSS media query matches.
 *
 * Uses `window.matchMedia` to listen for viewport changes and returns
 * a boolean that updates in real-time as the viewport crosses breakpoints.
 *
 * Example:
 *   const isMobile = useMediaQuery("(max-width: 767px)");
 *   const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(query).matches;
  });

  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);

    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [query]);

  return matches;
}

/**
 * Tailwind `md` breakpoint is 768px. This hook returns true when the viewport
 * is narrower than that — i.e., a "mobile" layout where we show one panel
 * at a time instead of the side-by-side resizable split.
 */
export function useIsMobile(): boolean {
  return useMediaQuery("(max-width: 767px)");
}
