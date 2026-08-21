import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `--color-border-primary` is the panel-divider token (see the `design-language`
 * skill), and a divider has to be visible against BOTH surfaces it separates —
 * the panel it belongs to (`--color-bg-primary`) and the panel on the other side
 * of it, which is very often `--color-bg-secondary`.
 *
 * Only the first of those was ever checked. The result was that all 18 themes
 * passed a casual eye on a Retina display, where a 1px CSS border paints as two
 * physical pixels, and 17 of them failed on an ordinary 1x display, where it
 * paints as one. Solarized was the extreme case: `--color-border-primary` and
 * `--color-bg-secondary` were the same value (`#073642`), so the divider between
 * the chat panel and the preview panel did not exist at any pixel ratio.
 *
 * This test pins both directions so the bg-secondary side cannot rot again while
 * the bg-primary side still looks fine.
 */

const THEME_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * The agreed floor. It is deliberately far below the WCAG 3:1 non-text minimum:
 * a divider is a decorative separator rather than a UI control that must be
 * identified, and dragging every theme to 3:1 would turn ShipIt's panels into
 * hard-ruled boxes. 1.4 is the point at which a 1px hairline stays legible on a
 * 1x display without reading as a frame. Raising it is a design decision, not a
 * correctness one — change the mock, not just this number.
 */
const MIN_CONTRAST = 1.4;

/**
 * How far `--color-border-secondary` (input borders) must stay from
 * `--color-border-primary` (dividers). 1.18 is the smallest separation the
 * themes shipped with before the divider was raised, so this preserves the
 * existing ramp rather than inventing a new one.
 */
const MIN_TOKEN_SEPARATION = 1.18;

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(a: string, b: string): number {
  const [l1, l2] = [relativeLuminance(a), relativeLuminance(b)];
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/**
 * Comments are stripped and the LAST declaration wins, which is what the cascade
 * actually does. A naive first-match regex reads a commented-out value, or an
 * earlier declaration that a later one overrides, and then every assertion below
 * is checking a colour the browser never paints — a guard that fails open.
 */
function readToken(css: string, name: string): string | undefined {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const matches = [...withoutComments.matchAll(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`, "g"))];
  return matches.at(-1)?.[1];
}

const themeFiles = fs
  .readdirSync(THEME_DIR)
  .filter((f) => f.endsWith(".css"))
  .sort();

describe("theme border contrast", () => {
  it("finds the theme stylesheets", () => {
    // Guards the glob itself: a renamed directory would otherwise turn every
    // it.each below into zero silently-passing cases.
    expect(themeFiles.length).toBeGreaterThanOrEqual(18);
  });

  it.each(themeFiles)("%s separates both panel surfaces", (file) => {
    const css = fs.readFileSync(path.join(THEME_DIR, file), "utf8");
    const border = readToken(css, "border-primary");
    const bgPrimary = readToken(css, "bg-primary");
    const bgSecondary = readToken(css, "bg-secondary");

    expect(border, `${file} declares --color-border-primary`).toBeDefined();
    expect(bgPrimary, `${file} declares --color-bg-primary`).toBeDefined();
    expect(bgSecondary, `${file} declares --color-bg-secondary`).toBeDefined();

    const againstPrimary = contrastRatio(border!, bgPrimary!);
    const againstSecondary = contrastRatio(border!, bgSecondary!);

    // Compared raw, NOT rounded to 2dp. Rounding first admits anything from
    // 1.395 up as "1.40", and several themes clear the floor by as little as
    // 0.0001, so that slack is the whole margin rather than a rounding detail.
    expect(
      againstPrimary,
      `${file}: divider on --color-bg-primary`,
    ).toBeGreaterThanOrEqual(MIN_CONTRAST);

    expect(
      againstSecondary,
      `${file}: divider on --color-bg-secondary (the preview-panel side)`,
    ).toBeGreaterThanOrEqual(MIN_CONTRAST);
  });

  /**
   * Raising the divider token pushed it into the input-border token's range and
   * silently flattened a distinction four components rely on: PresentGallery,
   * ServiceList, PreviewPath and SubAgentCards all render a `border-primary`
   * edge that becomes `border-secondary` on hover. When the two values converge,
   * that hover state still fires and produces no visible change.
   *
   * Every theme shipped a separation of at least 1.18 before this was noticed,
   * so the ramp is intentional, not incidental.
   */
  it.each(themeFiles)("%s keeps the input border distinct from the divider", (file) => {
    const css = fs.readFileSync(path.join(THEME_DIR, file), "utf8");
    const divider = readToken(css, "border-primary");
    const input = readToken(css, "border-secondary");

    expect(input, `${file} declares --color-border-secondary`).toBeDefined();
    expect(
      contrastRatio(divider!, input!),
      `${file}: border-primary -> border-secondary hover transition must stay visible`,
    ).toBeGreaterThanOrEqual(MIN_TOKEN_SEPARATION);
  });

  it.each(themeFiles)("%s keeps the divider distinct from the panel", (file) => {
    // The specific defect that started this: a divider token equal to the
    // surface beside it is not a faint line, it is no line.
    const css = fs.readFileSync(path.join(THEME_DIR, file), "utf8");
    expect(readToken(css, "border-primary")).not.toBe(readToken(css, "bg-secondary"));
    expect(readToken(css, "border-primary")).not.toBe(readToken(css, "bg-primary"));
  });
});
