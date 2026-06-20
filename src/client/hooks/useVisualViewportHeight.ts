// eslint-disable-next-line no-restricted-imports -- useEffect: window.visualViewport listener with cleanup (browser API subscription)
import { useEffect } from "react";

/**
 * Binds the app shell's height to the **visual viewport** instead of `100dvh`.
 *
 * Why: `dvh` units shrink when the browser's retractable URL bar hides, but they
 * do NOT shrink when the on-screen keyboard opens. With a `h-[100dvh]` shell the
 * keyboard then covers the bottom of the layout, and the body background shows
 * through as a white gap between the content (e.g. the mobile tab bar) and the
 * keyboard. `window.visualViewport.height` is the one measurement that excludes
 * the keyboard, so tracking it keeps the shell exactly as tall as the visible
 * area.
 *
 * This writes two CSS custom properties on the document element:
 *   --app-vh:     the visual viewport height in px (the shell height)
 *   --app-vv-top: the visual viewport offsetTop in px (iOS scrolls the layout
 *                 viewport under the keyboard; translating by this keeps the
 *                 shell pinned to the visible region)
 *
 * The shell falls back to `100dvh` / `0` until the first measurement lands, so
 * there's no flash and environments without `visualViewport` (older browsers,
 * tests) keep the previous behavior.
 */
export function useVisualViewportHeight(): void {
  // eslint-disable-next-line no-restricted-syntax -- browser API subscription with cleanup
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const root = document.documentElement;
    const apply = () => {
      root.style.setProperty("--app-vh", `${vv.height}px`);
      root.style.setProperty("--app-vv-top", `${vv.offsetTop}px`);
    };

    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      root.style.removeProperty("--app-vh");
      root.style.removeProperty("--app-vv-top");
    };
  }, []);
}
