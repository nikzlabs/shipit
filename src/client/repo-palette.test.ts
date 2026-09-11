import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_COLOR_ASSIGNMENT_ORDER, REPO_COLOR_COUNT } from "../server/shared/repo-colors.js";
import { groupBandFill } from "./components/SessionSidebar/SessionGroup.js";

/**
 * docs/254-repo-group-separation req 9 — the repo-identity palette must not be mistakable for the
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

const DARK_THEMES = ["dark", "midnight", "forest", "rose", "claude", "codex", "opencode", "grok", "solarized", "high-contrast"];

const HOT_TOKENS = ["--color-pr", "--color-success", "--color-sandbox"];

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

/**
 * docs/254 — colors are handed out SPREAD, not in palette order.
 *
 * The palette is laid out as a hue wheel because that is what the picker grid
 * wants, and `pickRepoColorIndex` originally walked it in index order — so a
 * workspace's first three repos got Clay, Ochre and Mustard, three adjacent
 * warm ochres. Every entry passed the mutual-distinguishability test above (all
 * 16 are ≥44 apart), which is the point: "no two entries are identical" does
 * not give you "the ones actually in use look different", and only the second
 * one is visible to a user with three repos.
 *
 * So the property under test is about the ORDER, and it is stated the way the
 * user experiences it: as each repo is added, how far is its color from the
 * closest color already on screen? Walking the palette in order that bottoms
 * out at 53 by the third repo; the assignment order holds 95+ through the
 * fourth and degrades gracefully after.
 *
 * Thresholds are deliberately well under what the current order achieves — this
 * guards against a regression to sequential assignment, not against a retune.
 */
describe("docs/254 — assignment order spreads the palette", () => {
  const palette = readPalette();

  const gap = (i: number, j: number) =>
    Math.min(
      difference(parseHex(palette.light[i]), parseHex(palette.light[j])),
      difference(parseHex(palette.dark[i]), parseHex(palette.dark[j])),
    );

  const nearestOnArrival = (order: readonly number[]): number[] =>
    order.slice(1).map((idx, k) => Math.min(...order.slice(0, k + 1).map((prev) => gap(idx, prev))));

  const MIN_EARLY = 80;             
  const MIN_ANY = MIN_MUTUAL;

  it("keeps the first repos far apart as they arrive", () => {
    const gaps = nearestOnArrival(REPO_COLOR_ASSIGNMENT_ORDER);
    for (const [k, d] of gaps.slice(0, 4).entries()) {
      expect(d, `repo #${k + 2} lands only ${d.toFixed(0)} from a color already in use`)
        .toBeGreaterThanOrEqual(MIN_EARLY);
    }
  });

  it("never lands a new repo on top of an existing one", () => {
    for (const [k, d] of nearestOnArrival(REPO_COLOR_ASSIGNMENT_ORDER).entries()) {
      expect(d, `repo #${k + 2} lands only ${d.toFixed(0)} from a color already in use`)
        .toBeGreaterThanOrEqual(MIN_ANY);
    }
  });

  // palette is retuned — whatever the hues become, spread must beat sequential.
  it("beats walking the palette in index order", () => {
    const sequential = nearestOnArrival(Array.from({ length: REPO_COLOR_COUNT }, (_, i) => i));
    const spread = nearestOnArrival(REPO_COLOR_ASSIGNMENT_ORDER);
    for (const n of [3, 5, 8]) {
      const worst = (g: number[]) => Math.min(...g.slice(0, n - 1));
      expect(worst(spread), `with ${n} repos, the assignment order is no better than palette order`)
        .toBeGreaterThan(worst(sequential));
    }
  });
});

/**
 * docs/254 — the header band's WEIGHT.
 *
 * The band shipped as `--color-bg-tertiary`, picked to maximize contrast. That
 * reads correctly on a dark theme (the token is lighter than the rail, so the
 * header looks gently raised) and wrong on a light one (it is *darker* than
 * every session row, so the headers outweigh their own content and a collapsed
 * group becomes a slab). Nothing caught it: the value is a single shared token,
 * and the defect only exists in one of the two surface directions.
 *
 * So the ceilings below are deliberately asymmetric — that asymmetry IS the
 * finding. A dark-hue-over-light-rail band reads heavier than a
 * light-hue-over-dark-rail band at the same contrast ratio, so light themes get
 * far less headroom. The light ceiling is set below the value that shipped and
 * looked wrong (Claude Light's `bg-tertiary`, 1.25), so reverting to a neutral
 * fill fails here rather than in someone's eyes.
 *
 * WHAT THIS DOES NOT ESTABLISH (raised in the Codex review of PR #2045). Every
 * measurement here is band-against-RAIL. It is tempting to read that as "the
 * header never outweighs its own rows", and it is not the same claim: the rows'
 * own highlight (`--color-bg-secondary`) varies far more across themes than the
 * band does — from 1.045 (`light`) to 1.155 (`solarized`) against the rail — so
 * band-under-row holds in Claude Light (1.108 < 1.120) and Solarized Light but
 * NOT in `light`, `codex-light`, `cool-light` or `warm-light`, where the band
 * sits a hair above a very weak row highlight. Asserting band < row would fail
 * on four shipped themes today, so it isn't the rule; these are aesthetic
 * regression guardrails, not a proof that no visually heavy result can pass.
 */
describe("docs/254 — header band weight", () => {
  const MIN_SEPARATION = 1.04;                                                        
  const MAX_SEPARATION = { light: 1.15, dark: 1.3 };

  const MAX_SPREAD = 0.15;

  const css = fs.readFileSync(cssPath, "utf8");
  const palette = readPalette();

  function readBandMix(): { light: number; dark: number } {
    const firstEntry = css.indexOf("--repo-color-0");
    const read = (from: number, label: string): number => {
      expect(from, `block not found: ${label}`).toBeGreaterThan(-1);
      const m = /--repo-band-mix:\s*([\d.]+)%/.exec(css.slice(from, css.indexOf("}", from)));
      expect(m, `--repo-band-mix missing from the ${label} block`).toBeTruthy();
      return Number(m![1]) / 100;
    };
    return {
      light: read(css.lastIndexOf(":root {", firstEntry), "light :root"),
      dark: read(css.indexOf(".dark,", firstEntry), "dark-theme"),
    };
  }

  function readRails(): { name: string; surface: "light" | "dark"; bg: Rgb }[] {
    return fs
      .readdirSync(themesDir)
      .filter((f) => f.endsWith(".css"))
      .map((file) => {
        const name = file.replace(/\.css$/, "");
        const m = /--color-bg-primary:\s*(#[0-9a-fA-F]{6})\b/.exec(
          fs.readFileSync(path.join(themesDir, file), "utf8"),
        );
        expect(m, `--color-bg-primary missing or not 6-digit hex in ${file}`).toBeTruthy();
        return { name, surface: (DARK_THEMES.includes(name) ? "dark" : "light") as "light" | "dark", bg: parseHex(m![1]) };
      });
  }

  function mix(color: Rgb, bg: Rgb, fraction: number): Rgb {
    return color.map((v, i) => Math.round(v * fraction + bg[i] * (1 - fraction))) as Rgb;
  }

  function relativeLuminance([r, g, b]: Rgb): number {
    const [rs, gs, bs] = [r, g, b].map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
  }

  function contrast(a: Rgb, b: Rgb): number {
    const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  }

  const mixes = readBandMix();
  const rails = readRails();

  const bandsFor = (rail: (typeof rails)[number]): number[] =>
    palette[rail.surface].map((hex) => contrast(mix(parseHex(hex), rail.bg, mixes[rail.surface]), rail.bg));

  it("defines a mix fraction for both surface directions", () => {
    expect(mixes.light).toBeGreaterThan(0);
    expect(mixes.dark).toBeGreaterThan(0);
  });

  it("models the same color space production actually mixes in", () => {
    expect(groupBandFill("#123456").startsWith("color-mix(in srgb,")).toBe(true);
  });

  // The band is only opaque because BOTH color-mix inputs are. `color-mix` does

  it("feeds the band only opaque colors, in every theme", () => {
    const opaque = /^#[0-9a-fA-F]{6}$/;
    for (const surface of ["light", "dark"] as const) {
      for (const [i, c] of palette[surface].entries()) {
        expect(opaque.test(c), `--repo-color-${i} (${c}) is not an opaque 6-digit hex`).toBe(true);
      }
    }

    const sources = [
      ...fs.readdirSync(themesDir).filter((f) => f.endsWith(".css")).map((f) => [f, path.join(themesDir, f)] as const),
      ["index.css", cssPath] as const,
    ];
    let checked = 0;
    for (const [label, file] of sources) {
      const text = fs.readFileSync(file, "utf8");
      for (const token of ["--color-warning", "--color-sandbox"]) {
        for (const m of text.matchAll(new RegExp(`${token}:\\s*([^;]+);`, "g"))) {
          expect(opaque.test(m[1].trim()), `${label}: ${token} is "${m[1].trim()}", which is not opaque`).toBe(true);
          checked++;
        }
      }
    }
    expect(checked, "found no semantic band colors to check — did a token get renamed?").toBeGreaterThan(0);
  });

  it("checks every theme that ships", () => {
    expect(rails.length).toBeGreaterThanOrEqual(14);
    expect(rails.some((r) => r.surface === "light")).toBe(true);
    expect(rails.some((r) => r.surface === "dark")).toBe(true);
  });

  it("keeps the band's separation from the rail inside the faint range", () => {
    for (const rail of rails) {
      for (const [i, ratio] of bandsFor(rail).entries()) {
        expect(
          ratio,
          `${rail.name}: --repo-color-${i}'s band is ${ratio.toFixed(3)} against the rail — too heavy for a ${rail.surface} theme`,
        ).toBeLessThanOrEqual(MAX_SEPARATION[rail.surface]);
      }
    }
  });

  it("keeps the band strong enough to read as a header at all", () => {
    for (const rail of rails) {
      for (const [i, ratio] of bandsFor(rail).entries()) {
        expect(ratio, `${rail.name}: --repo-color-${i}'s band is only ${ratio.toFixed(3)} against the rail`)
          .toBeGreaterThanOrEqual(MIN_SEPARATION);
      }
    }
  });

  it("weighs every repo's header about the same within a theme", () => {
    for (const rail of rails) {
      const bands = bandsFor(rail);
      const spread = Math.max(...bands) - Math.min(...bands);
      expect(spread, `${rail.name}: header weight varies by ${spread.toFixed(3)} across the palette`)
        .toBeLessThanOrEqual(MAX_SPREAD);
    }
  });
});
