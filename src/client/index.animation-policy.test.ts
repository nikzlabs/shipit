/**
 * docs/265 — the 10 Hz rule for always-on animation.
 *
 * A page holding a live IntersectionObserver runs the whole main-thread
 * rendering lifecycle on every frame the browser SCHEDULES, and a running
 * animation schedules one per vsync. ShipIt always holds such observers, so an
 * infinite animation written at display rate costs an idle session ~118 ms of
 * main thread per second. A `steps(N)` one wakes the main thread N times per
 * iteration instead.
 *
 * The cost is the UNION over running animations, so this has to hold for EVERY
 * infinite animation rather than most of them: one un-stepped animation pins the
 * page back at display rate and cancels the saving from all the others. That is
 * why this is a test and not a comment.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(here, "index.css"), "utf8");

/** The grid every always-on animation advances on, in seconds. */
const TICK_S = 0.1;

function parseSeconds(raw: string): number {
  return raw.endsWith("ms") ? Number(raw.slice(0, -2)) / 1000 : Number(raw.slice(0, -1));
}

/** Every `animation:` shorthand in the stylesheet that declares `infinite`. */
function infiniteShorthands(): { decl: string; durationS: number; steps: number | null }[] {
  const out: { decl: string; durationS: number; steps: number | null }[] = [];
  for (const m of css.matchAll(/animation:\s*([^;]+);/g)) {
    const decl = m[1].replace(/\s+/g, " ").trim();
    if (!/\binfinite\b/.test(decl)) continue;
    const duration = /(?:^|\s)(\d*\.?\d+m?s)(?:\s|$)/.exec(decl);
    const steps = /\bsteps\(\s*(\d+)\s*\)/.exec(decl);
    out.push({
      decl,
      durationS: duration ? parseSeconds(duration[1]) : NaN,
      steps: steps ? Number(steps[1]) : null,
    });
  }
  return out;
}

describe("always-on animation stays on the 10 Hz grid", () => {
  it("finds the infinite animations it is meant to be checking", () => {
    // Without this the whole file passes vacuously the day the shorthand syntax
    // or the file layout changes — the failure mode that makes a guard test
    // worthless. docs/265 hit it four separate times with other instruments.
    const found = infiniteShorthands();
    expect(found.length).toBeGreaterThanOrEqual(8);
  });

  it.each(infiniteShorthands())("$decl steps at 10 Hz", ({ decl, durationS, steps }) => {
    expect(steps, `\`${decl}\` is infinite, so it must use steps(); an un-stepped `
      + `animation schedules a main-thread frame every vsync and cancels the saving `
      + `from every other stepped animation on the page.`).not.toBeNull();
    expect(durationS, `could not read a duration out of \`${decl}\``).not.toBeNaN();
    expect(steps, `\`${decl}\` should step ${durationS / TICK_S} times `
      + `(${durationS}s ÷ ${TICK_S}s), so it advances 10 times a second.`)
      .toBe(Math.round(durationS / TICK_S));
  });

  it("overrides Tailwind's own always-on utilities", () => {
    // `animate-spin` / `animate-pulse` / `animate-ping` ship as linear and
    // cubic-bezier, and they are the animations ShipIt actually uses most. They
    // are re-declared in an `@theme` block rather than at each call site.
    for (const name of ["spin", "ping", "pulse"]) {
      const decl = new RegExp(`--animate-${name}:[^;]+;`).exec(css)?.[0];
      expect(decl, `--animate-${name} must be overridden in @theme`).toBeDefined();
      expect(decl).toMatch(/steps\(\d+\)/);
    }
  });

  it("keeps every animation-delay a whole multiple of the tick", () => {
    // Step boundaries are measured from each animation's OWN start time, so a
    // delay off the grid gives that element a tick train of its own and its cost
    // adds to the others'. Measured: two 10 Hz animations 37 ms apart cost 15
    // frames per second, not 10.
    const offGrid: string[] = [];
    for (const m of css.matchAll(/animation-delay:\s*([^;]+);/g)) {
      const seconds = parseSeconds(m[1].trim());
      if (Number.isNaN(seconds)) continue;
      // Compare in integer milliseconds — 0.7 / 0.1 is 6.999… in binary floats.
      if (Math.round(seconds * 1000) % Math.round(TICK_S * 1000) !== 0) offGrid.push(m[1].trim());
    }
    expect(offGrid, "animation-delay values off the 10 Hz grid").toEqual([]);
  });
});
