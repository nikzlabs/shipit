import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * docs/260 req 16 — the sidebar's "Needs you" switch must be legible in every
 * theme, light and dark.
 *
 * This is a guard test rather than a review note because the failure is
 * invisible in a diff and was already shipped once: `--color-attention` is
 * tuned as a 3px marker on a row, and at that job it works — but reused as
 * 10–16px text and glyph it measures **2.35–2.89:1** on the light themes'
 * surfaces, well under the 4.5:1 WCAG AA asks of small text. `--color-attention-text`
 * exists to carry the same amber at a shade that clears the bar, and nothing
 * except this test would notice a future palette edit undoing that.
 *
 * Both surfaces the control can sit on are checked: the header
 * (`--color-bg-primary`) at rest, and the pressed chip (`--color-bg-tertiary`),
 * which is the darker of the two on light themes and therefore the binding one.
 */

const themesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "themes");

/** WCAG 2.x relative luminance. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const channel = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function readToken(css: string, token: string, file: string): string {
  const match = new RegExp(`${token}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  expect(match, `${token} missing from ${file}`).toBeTruthy();
  return match![1].toLowerCase();
}

const AA_SMALL_TEXT = 4.5;

describe("attention switch contrast", () => {
  const files = fs.readdirSync(themesDir).filter((f) => f.endsWith(".css"));

  it("finds every theme", () => {
    expect(files.length).toBe(14);
  });

  for (const file of files) {
    it(`${file}: --color-attention-text clears AA on both surfaces`, () => {
      const css = fs.readFileSync(path.join(themesDir, file), "utf8");
      const fg = readToken(css, "--color-attention-text", file);
      for (const surface of ["--color-bg-primary", "--color-bg-tertiary"]) {
        const bg = readToken(css, surface, file);
        const ratio = contrast(fg, bg);
        expect(
          ratio,
          `${file}: ${fg} on ${surface} (${bg}) is ${ratio.toFixed(2)}:1, needs ${AA_SMALL_TEXT}:1`,
        ).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
      }
    });
  }
});
