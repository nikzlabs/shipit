// eslint-disable-next-line no-restricted-imports -- useEffect: observes the <html> theme class to recompute on theme switch (external system sync)
import { useState, useEffect } from "react";
import { luminanceOfCssColor } from "../utils/status-color.js";

/**
 * Relative luminance of a theme surface token (e.g. `--color-bg-primary` for
 * rows, `--color-bg-elevated` for popovers/menus). Feeds the contrast-adaptive
 * status colors ({@link adaptColorForSurface}) so a dot/checkbox knows whether
 * its background is light or dark — and exactly how light/dark — for the current
 * theme. Recomputes when the theme changes, which the app signals by swapping
 * the class on `<html>` (see `useTheme`), so this works for every theme without
 * a light/dark flag.
 */
function readSurfaceLuminance(cssVar: string): number {
  if (typeof window === "undefined") return 1;
  const value = getComputedStyle(document.documentElement).getPropertyValue(cssVar);
  return luminanceOfCssColor(value || "#ffffff");
}

export function useSurfaceLuminance(cssVar: string): number {
  const [lum, setLum] = useState(() => readSurfaceLuminance(cssVar));

  // eslint-disable-next-line no-restricted-syntax -- subscribe to the <html> theme-class mutation to recompute the surface luminance
  useEffect(() => {
    const update = () => setLum(readSurfaceLuminance(cssVar));
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, [cssVar]);

  return lum;
}
