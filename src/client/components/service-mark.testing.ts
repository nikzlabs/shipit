/**
 * Find the vendor mark {@link ServiceLogo} draws inside `root`, or `null` when
 * there is none. Test-only; the filename keeps it out of the `*.test.ts(x)` glob
 * that collects suites.
 *
 * **Why a helper rather than `querySelector('svg[viewBox="0 0 24 24"]')`**, which
 * is what these assertions were until jsdom 30. That selector silently stopped
 * matching. jsdom 30's selector engine fails VALUE comparisons on case-sensitive
 * foreign (SVG) attributes: `svg[viewBox]` still matches on presence and
 * `svg[width="12"]` still matches on value, but `svg[viewBox="0 0 24 24"]` never
 * matches — on an element whose `getAttribute("viewBox")` returns exactly that
 * string. `element.matches()` agrees with the miss, so it is the engine and not
 * the DOM.
 *
 * That broke all four positive mark assertions at once. The part worth spelling
 * out is what it did to the NEGATIVE one — `ServiceSelector`'s "draws no mark
 * when the selection is not in the list" — which kept **passing**: a selector
 * that can never match satisfies `toBeNull()` regardless of what the DOM holds,
 * so the assertion stopped testing anything while still reading green. Going
 * through `getAttribute` puts the check back on the DOM.
 *
 * **The 24×24 grid is the discriminator, not `svg` on its own.** A selected row
 * carries a checkmark and every trigger carries a caret — both Phosphor glyphs,
 * drawn on a 256×256 grid — so a bare `svg` query passes with the logo missing,
 * which is the exact regression these tests exist to catch. Simple Icons' marks,
 * the ones `ServiceLogo` draws, are 24×24.
 */

/** The grid every `ServiceLogo` mark is drawn on. See `ServiceLogo.tsx`. */
export const MARK_VIEW_BOX = "0 0 24 24";

/** The first vendor mark under `root`, or `null` when the row carries none. */
export function queryServiceMark(root: Element): SVGSVGElement | null {
  for (const svg of root.querySelectorAll("svg")) {
    if (svg.getAttribute("viewBox") === MARK_VIEW_BOX) return svg;
  }
  return null;
}
