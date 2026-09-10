import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
    expect(files.length).toBe(18);
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
