/**
 * Finding a vendor mark ({@link ServiceLogo}) in a rendered tree, for tests.
 *
 * ## Why this is not a CSS selector
 *
 * The obvious spelling is `root.querySelector('svg[viewBox="0 0 24 24"]')`, and
 * that is what these tests used until jsdom 30. It cannot be used any more:
 * **jsdom 30 does not match an attribute-*value* selector against a camelCase
 * attribute on an SVG element.** Narrowed on 30.0.1 — the DOM is correct and
 * only the selector engine is wrong:
 *
 * | selector                              | jsdom 30 | browsers |
 * | ------------------------------------- | -------- | -------- |
 * | `svg[viewBox]` (presence)             | matches  | matches  |
 * | `svg[viewBox="0 0 24 24"]` (value)    | **null** | matches  |
 * | `svg[fill="currentColor"]` (lowercase)| matches  | matches  |
 * | `div[viewBox="0 0 24 24"]` (on HTML)  | matches  | matches  |
 *
 * So it is specifically *value* matching, on a *camelCase* name, on a *foreign*
 * element. `getAttribute("viewBox")` returns `"0 0 24 24"` throughout and the
 * serialized HTML carries the attribute, so nothing is wrong with what React
 * renders — a real browser matches the selector. jsdom 30.0.1 is the latest
 * release as of 2026-08-18, so there is no fixed version to move to.
 *
 * Reading the attribute directly asserts exactly what the selector asserted,
 * without going through the engine that has the bug. Keep it this way even once
 * jsdom is fixed: it is the same assertion and it cannot regress with a
 * selector-engine change.
 *
 * ## Why the viewBox and not just `svg`
 *
 * `querySelector("svg")` is NOT good enough, and cross-backend review said so:
 * a selected row carries a checkmark and every trigger carries a caret, so a
 * bare `svg` query passes with the logo missing — the exact regression these
 * tests exist to catch. Every mark is drawn on Simple Icons' 24×24 grid while
 * Phosphor's glyphs are 256×256, which makes the viewBox an exact
 * discriminator. Matching on the *value* is the whole point; a presence check
 * (`svg[viewBox]`, which jsdom 30 does match) would pass on a Phosphor glyph
 * and quietly give up the discriminator.
 */

/** The grid every Simple Icons mark is drawn on. Phosphor's glyphs are 256×256. */
const MARK_VIEWBOX = "0 0 24 24";

/**
 * The first vendor mark inside `root`, or `null` if it has none.
 *
 * Mirrors `querySelector`'s contract — returns the element, returns `null` when
 * absent — so call sites read as they did before jsdom 30 forced the change.
 */
export function queryVendorMark(root: ParentNode): SVGSVGElement | null {
  const svgs = Array.from(root.querySelectorAll("svg"));
  return (
    svgs.find((svg) => svg.getAttribute("viewBox") === MARK_VIEWBOX) ?? null
  );
}
