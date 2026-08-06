import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_COLOR_COUNT } from "../server/shared/repo-colors.js";

/**
 * docs/254 req 9 — the repo-identity palette must not be mistakable for the
 * sidebar's status colors, in ANY theme.
 *
 * This is a guard test rather than a review note because the failure is silent
 * and easy to reintroduce: an earlier draft of the palette shipped an entry
 * seven units away from Codex Light's PR violet, i.e. visually identical to the
 * PR badge sitting a few pixels to its right on every session row. Nothing
 * about that is visible in a diff — you have to compare against fourteen
 * themes' tokens to see it. So the comparison lives here.
 *
 * Distances use a cheap "redmean" approximation of perceptual difference. The
 * absolute numbers aren't meaningful on their own; the thresholds were picked
 * by measuring the collision that shipped (7) against pairs that read as
 * clearly different (60+), and then leaving headroom.
 */

const dir = path.dirname(fileURLToPath(import.meta.url));
const cssPath = path.join(dir, "index.css");
const themesDir = path.join(dir, "themes");

/** Themes whose <html> class receives the dark palette overrides. */
const DARK_THEMES = ["dark", "midnight", "forest", "rose", "claude", "codex", "solarized", "high-contrast"];

/**
 * Status colors that appear as sidebar glyphs on or beside a session row — the
 * PR badge, the live-agent dot, the sandbox cube. These get the widest berth.
 */
const HOT_TOKENS = ["--color-pr", "--color-success", "--color-sandbox"];
/** Status colors that appear incidentally elsewhere in the app. */
const WARM_TOKENS = [
  "--color-error", "--color-warning", "--color-attention",
  "--color-accent", "--color-folder", "--color-autofix",
];

const MIN_VS_HOT = 48;
const MIN_VS_WARM = 38;
const MIN_MUTUAL = 44;

type Rgb = [number, number, number];

function parseHex(hex: string): Rgb {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
}

/** Redmean colour difference — cheap, and good enough to catch "these are the same". */
function difference(a: Rgb, b: Rgb): number {
  const rMean = (a[0] + b[0]) / 2;
  const [dr, dg, db] = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  return Math.sqrt((2 + rMean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rMean) / 256) * db * db);
}

function readPalette(): { light: string[]; dark: string[] } {
  const css = fs.readFileSync(cssPath, "utf8");
  const grab = (from: number, label: string): string[] => {
    expect(from, `palette block not found: ${label}`).toBeGreaterThan(-1);
    const block = css.slice(from, css.indexOf("}", from));
    return Array.from({ length: REPO_COLOR_COUNT }, (_, i) => {
      const m = new RegExp(`--repo-color-${i}:\\s*(#[0-9a-fA-F]{6})`).exec(block);
      expect(m, `--repo-color-${i} missing from the ${label} block`).toBeTruthy();
      return m![1];
    });
  };
  const firstEntry = css.indexOf("--repo-color-0");
  // Light values sit in the `:root {` block immediately preceding the first
  // entry; the dark overrides in the `.dark, …` block that follows it.
  return {
    light: grab(css.lastIndexOf(":root {", firstEntry), "light :root"),
    dark: grab(css.indexOf(".dark,", firstEntry), "dark-theme"),
  };
}

function readThemeTokens(tokens: string[]): { light: string[]; dark: string[] } {
  const light: string[] = [];
  const dark: string[] = [];
  for (const file of fs.readdirSync(themesDir).filter((f) => f.endsWith(".css"))) {
    const name = file.replace(/\.css$/, "");
    const css = fs.readFileSync(path.join(themesDir, file), "utf8");
    const target = DARK_THEMES.includes(name) ? dark : light;
    for (const token of tokens) {
      const m = new RegExp(`${token}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
      if (m) target.push(m[1]);
    }
  }
  return { light, dark };
}

describe("docs/254 — repo palette vs status colors", () => {
  const palette = readPalette();

  it("defines all 16 entries in both surface directions", () => {
    expect(palette.light).toHaveLength(REPO_COLOR_COUNT);
    expect(palette.dark).toHaveLength(REPO_COLOR_COUNT);
  });

  // The cascade trap documented for --color-sandbox: the theme class sits on
  // <html>, the same element as :root, so dark values placed in :root would win
  // on source order and clobber every light theme.
  it("scopes the dark values to the dark-theme classes, not :root", () => {
    const css = fs.readFileSync(cssPath, "utf8");
    const darkSelector = css.slice(css.indexOf(".dark,", css.indexOf("--repo-color-0")));
    for (const theme of DARK_THEMES) {
      expect(darkSelector.slice(0, darkSelector.indexOf("{"))).toContain(theme);
    }
  });

  it("covers every dark theme that ships", () => {
    const shipped = fs
      .readdirSync(themesDir)
      .filter((f) => f.endsWith(".css"))
      .map((f) => f.replace(/\.css$/, ""));
    // Every theme this test calls dark must actually exist…
    for (const t of DARK_THEMES) expect(shipped).toContain(t);
    // …and every shipped theme must be classified one way or the other, so a
    // newly-added dark theme can't silently inherit the light palette.
    const css = fs.readFileSync(cssPath, "utf8");
    const darkVariant = css.slice(css.indexOf("@custom-variant dark"), css.indexOf("\n", css.indexOf("@custom-variant dark")));
    for (const t of shipped) {
      const isDark = darkVariant.includes(`.${t},`) || darkVariant.includes(`.${t} `);
      expect(DARK_THEMES.includes(t), `theme "${t}" classified inconsistently with @custom-variant dark`).toBe(isDark);
    }
  });

  for (const surface of ["light", "dark"] as const) {
    describe(surface, () => {
      const pal = () => palette[surface].map(parseHex);

      it("stays clear of the status colors that appear on session rows", () => {
        const status = readThemeTokens(HOT_TOKENS)[surface].map(parseHex);
        expect(status.length).toBeGreaterThan(0);
        for (const [i, c] of pal().entries()) {
          for (const s of status) {
            const d = difference(c, s);
            expect(
              d,
              `--repo-color-${i} (${palette[surface][i]}) is ${d.toFixed(0)} from a PR/live/sandbox color`,
            ).toBeGreaterThanOrEqual(MIN_VS_HOT);
          }
        }
      });

      it("stays clear of the app's other status colors", () => {
        const status = readThemeTokens(WARM_TOKENS)[surface].map(parseHex);
        for (const [i, c] of pal().entries()) {
          for (const s of status) {
            const d = difference(c, s);
            expect(d, `--repo-color-${i} (${palette[surface][i]}) is ${d.toFixed(0)} from a status color`)
              .toBeGreaterThanOrEqual(MIN_VS_WARM);
          }
        }
      });

      // req 5 is worthless if two palette entries are indistinguishable: the
      // repos would have "different" colors that nobody can tell apart.
      it("keeps its own entries distinguishable from each other", () => {
        const colors = pal();
        for (let i = 0; i < colors.length; i++) {
          for (let j = i + 1; j < colors.length; j++) {
            const d = difference(colors[i], colors[j]);
            expect(d, `--repo-color-${i} and --repo-color-${j} are only ${d.toFixed(0)} apart`)
              .toBeGreaterThanOrEqual(MIN_MUTUAL);
          }
        }
      });
    });
  }
});
