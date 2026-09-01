/**
 * docs/265 — what an infinite CSS animation is allowed to be.
 *
 * A page holding a live IntersectionObserver runs the whole main-thread
 * rendering lifecycle on every frame the browser SCHEDULES, and a running
 * animation schedules one per vsync. ShipIt always holds such observers, so an
 * infinite animation written the ordinary way costs an idle session ~150 ms of
 * main thread per second.
 *
 * Two rules make one cheap, and BOTH are needed:
 *
 *   1. It may animate only `transform` and `opacity`. Rule 2 does nothing
 *      without this — a `steps(240)` animation of `stroke-dashoffset` was
 *      measured still driving 60 main-thread frames a second, against 10 for the
 *      same `steps()` on `transform`. Only a compositor-only property lets the
 *      main thread stay asleep between steps.
 *   2. It must step at about 10 times a second, so it wakes the main thread when
 *      its value changes rather than every vsync.
 *
 * The cost is the UNION over running animations: one animation breaking either
 * rule puts the whole page back at display rate and cancels the saving from all
 * the others. That is why this is a test rather than a comment — the first draft
 * of this work shipped a `stroke-dashoffset` animation that silently did exactly
 * that, and every syntactic check passed.
 *
 * A finite animation is exempt from both. It stops, so it costs nothing in the
 * steady state, and it is the right shape for decoration.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(here, "index.css"), "utf8");
// Tailwind's own theme is the second source of truth: `--animate-spin` is
// overridden here but `@keyframes spin` is declared there, so rule 1 can only be
// checked against both files.
const tailwindCss = fs.readFileSync(
  path.join(here, "../../node_modules/tailwindcss/theme.css"), "utf8");

/** Steps per second an infinite animation should run at, and the tolerated band. */
const TARGET_HZ = 10;
const MIN_HZ = 8;
const MAX_HZ = 15;

/** The only properties Chrome can animate without waking the main thread. */
const COMPOSITOR_ONLY = new Set(["transform", "opacity"]);

function parseSeconds(raw: string): number {
  return raw.endsWith("ms") ? Number(raw.slice(0, -2)) / 1000 : Number(raw.slice(0, -1));
}

/**
 * The properties a `@keyframes` block touches. Read from the stylesheet rather
 * than assumed from the animation's name: `preview-art-march` sounds like
 * movement and animates `stroke-dashoffset`.
 */
function keyframeProperties(name: string): string[] {
  const source = [css, tailwindCss].find((s) => s.includes(`@keyframes ${name}`));
  if (!source) return [];
  // Brace-count rather than regex to the closing brace — a @keyframes body
  // contains nested blocks, so `[^}]*` stops at the first inner one and reports
  // an almost-empty property list. That failure is silent and passes.
  const start = source.indexOf(`@keyframes ${name}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  let end = open;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) { end = i; break; }
  }
  const body = source.slice(open + 1, end);
  return [...new Set([...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]))];
}

interface Infinite { decl: string; name: string; durationS: number; steps: number | null }

/**
 * Every infinite animation this stylesheet declares: `animation:` shorthands, the
 * `--animate-*` theme values (which become exactly such a shorthand at every
 * `animate-…` call site), and the `animation-iteration-count: infinite` longhand.
 * All three spellings cost the same at runtime, so all three are checked.
 */
function infiniteAnimations(): Infinite[] {
  const out: Infinite[] = [];
  const known = [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1])
    .concat([...tailwindCss.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]));
  // `animation:` shorthands, plus the `--animate-*` theme values, which become
  // exactly such a shorthand at every `animate-…` call site.
  const declarations = [
    ...[...css.matchAll(/animation:\s*([^;]+);/g)],
    ...[...css.matchAll(/--animate-[\w-]+:\s*([^;]+);/g)],
  ];
  for (const m of declarations) {
    const decl = m[1].replace(/\s+/g, " ").trim();
    if (!/\binfinite\b/.test(decl)) continue;
    const duration = /(?:^|\s)(\d*\.?\d+m?s)(?:\s|$)/.exec(decl);
    const steps = /\bsteps\(\s*(\d+)\s*\)/.exec(decl);
    out.push({
      decl,
      name: known.find((k) => new RegExp(`(^|\\s)${k}(\\s|$)`).test(decl)) ?? "",
      durationS: duration ? parseSeconds(duration[1]) : NaN,
      steps: steps ? Number(steps[1]) : null,
    });
  }
  // The longhand spelling. Nothing uses it today; it is checked so that adopting
  // it does not quietly leave the rules behind.
  for (const m of css.matchAll(/animation-iteration-count:\s*infinite/g)) {
    out.push({ decl: css.slice(Math.max(0, m.index - 200), m.index + 40), name: "", durationS: NaN, steps: null });
  }
  return out;
}

describe("infinite animation stays cheap", () => {
  it("finds the infinite animations it is meant to be checking", () => {
    // Without this the whole file passes vacuously the day the shorthand syntax
    // or the file layout changes. docs/265 hit that failure with four separate
    // instruments before anyone noticed.
    expect(infiniteAnimations().length).toBeGreaterThanOrEqual(4);
  });

  it("can read the properties out of a @keyframes block", () => {
    // Positive control for `keyframeProperties`: a helper that always returns []
    // would pass the compositor-only rule for everything.
    expect(keyframeProperties("spin-slow")).toEqual(["transform"]);
    expect(keyframeProperties("preview-art-march")).toContain("stroke-dashoffset");
  });

  it.each(infiniteAnimations())("$decl", ({ decl, name, durationS, steps }) => {
    expect(name, `could not match \`${decl}\` to a @keyframes block`).not.toBe("");

    const props = keyframeProperties(name);
    const offCompositor = props.filter((p) => !COMPOSITOR_ONLY.has(p));
    expect(offCompositor, `\`${decl}\` animates ${offCompositor.join(", ")}, which Chrome `
      + `cannot run off the main thread. Stepping it saves nothing — measured at 60 `
      + `main-thread frames/s. Either animate transform/opacity instead, or make the `
      + `animation finite so it stops.`).toEqual([]);

    expect(steps, `\`${decl}\` is infinite, so it needs steps(); an un-stepped animation `
      + `schedules a main-thread frame every vsync and cancels the saving from every `
      + `other stepped animation on the page.`).not.toBeNull();
    expect(durationS, `could not read a duration out of \`${decl}\``).not.toBeNaN();

    const hz = (steps ?? 0) / durationS;
    expect(hz, `\`${decl}\` steps ${hz} times a second; aim for ${TARGET_HZ} `
      + `(steps(${Math.round(durationS * TARGET_HZ)}) at ${durationS}s).`)
      .toBeGreaterThanOrEqual(MIN_HZ);
    expect(hz).toBeLessThanOrEqual(MAX_HZ);
  });

  it("overrides Tailwind's own always-on utilities", () => {
    // `animate-spin` / `animate-pulse` / `animate-ping` ship as linear and
    // cubic-bezier, and they are the animations ShipIt uses most. They are
    // re-declared in an `@theme` block rather than at each call site.
    for (const name of ["spin", "ping", "pulse"]) {
      const decl = new RegExp(`--animate-${name}:[^;]+;`).exec(css)?.[0];
      expect(decl, `--animate-${name} must be overridden in @theme`).toBeDefined();
      expect(decl).toMatch(/steps\(\d+\)/);
    }
  });
});
