/**
 * The spinner has to READ as a rotating arc, and neither half of that is visible
 * in a unit test that renders it — so both are measured here, out of the shipped
 * `.spinner` CSS.
 *
 * Both halves have been got wrong already. The first opacity spinner lit twelve
 * SEPARATED bars, so it read as a ring of dashes rather than an arc; and each bar
 * jumped straight to full opacity, so the bright head stood still for 100 ms and
 * then moved a whole 30°. It drew at display rate and was still, correctly,
 * described as a stepper. Neither defect changes any rendered attribute, so only
 * a measurement catches them coming back.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(here, "../index.css"), "utf8");

interface Wedge { from: number; span: number; stops: [number, number][] }

/** Brace-matched, because a wedge's stops are themselves `{ … }` blocks. */
function keyframeBlock(name: string): string {
  const start = css.indexOf(`@keyframes ${name} {`);
  if (start === -1) return "";
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open, i + 1);
  }
  return "";
}

function wedges(): Wedge[] {
  const geometry = new Map<number, { from: number; span: number; keyframes: string }>();
  for (const m of css.matchAll(
    /\.spinner > i:nth-child\((\d+)\) \{ background: conic-gradient\(from ([\d.]+)deg, currentColor 0 ([\d.]+)deg[^}]*animation: ([\w-]+) /g,
  )) {
    geometry.set(Number(m[1]) - 1, { from: Number(m[2]), span: Number(m[3]), keyframes: m[4] });
  }

  return [...geometry.entries()].sort((a, b) => a[0] - b[0]).map(([, g]) => {
    const stops = [...keyframeBlock(g.keyframes).matchAll(/([\d.]+)% \{ opacity: ([\d.]+) \}/g)]
      .map((m) => [Number(m[1]) / 100, Number(m[2])] as [number, number])
      .sort((a, b) => a[0] - b[0]);
    return { from: g.from, span: g.span, stops };
  });
}

const opacityAt = (w: Wedge, t: number) => {
  for (let i = 0; i < w.stops.length - 1; i++) {
    const [t0, v0] = w.stops[i], [t1, v1] = w.stops[i + 1];
    if (t >= t0 && t <= t1) return t1 === t0 ? v1 : v0 + (v1 - v0) * ((t - t0) / (t1 - t0));
  }
  return w.stops[w.stops.length - 1][1];
};

/**
 * Where the eye reads the bright head as being: the luminance centroid of the
 * ring, unwrapped over one cycle. A rotation the viewer calls smooth advances it
 * by the same amount every sample.
 */
function centroidSteps(ring: Wedge[], samples = 1200): number[] {
  const angles: number[] = [];
  let previous: number | null = null;
  let unwrapped = 0;

  for (let s = 0; s < samples; s++) {
    const t = s / samples;
    let x = 0, y = 0;
    for (const w of ring) {
      const a = ((w.from + w.span / 2) * Math.PI) / 180;
      const weight = opacityAt(w, t);
      x += weight * Math.cos(a);
      y += weight * Math.sin(a);
    }
    const angle = Math.atan2(y, x);
    if (previous === null) unwrapped = angle;
    else {
      let d = angle - previous;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      unwrapped += d;
    }
    previous = angle;
    angles.push(unwrapped);
  }
  return angles.slice(1).map((a, i) => ((a - angles[i]) * 180) / Math.PI);
}

describe("the spinner reads as a rotating arc", () => {
  const ring = wedges();

  it("finds the wedges it is meant to be measuring", () => {
    expect(ring.length, "could not parse `.spinner > i:nth-child(n)` out of index.css — "
      + "the spinner rules changed shape and this whole file is now checking nothing")
      .toBeGreaterThan(2);
    for (const [i, w] of ring.entries()) {
      expect(w.stops.length, `wedge ${i} has no @keyframes stops`).toBeGreaterThan(1);
    }
  });

  it("draws one arc, not a ring of dashes", () => {

    const nominal = 360 / ring.length;
    for (const [i, w] of ring.entries()) {
      expect(w.from, `wedge ${i} is not at its share of the circle, so the wedges no `
        + `longer tile it in order`).toBeCloseTo(i * nominal, 1);
      expect(w.span, `wedge ${i} spans ${w.span}° of a ${nominal}° slot, so it does not `
        + `reach its neighbour. Gaps between the wedges are what made the old spinner `
        + `read as twelve dashes instead of an arc — each wedge must span at least its `
        + `own slot.`).toBeGreaterThanOrEqual(nominal);
    }
  });

  it("moves the bright head evenly instead of stepping it between wedges", () => {

    const steps = centroidSteps(ring);
    const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
    const worst = Math.max(...steps.map(Math.abs)) / Math.abs(mean);

    expect(Math.abs(mean * steps.length), "the head does not complete one revolution per cycle")
      .toBeCloseTo(360, 0);
    expect(worst, `the brightest point of the ring advances up to ${worst.toFixed(1)}x its `
      + `average step. That is a stepper: it holds still and then jumps, which is exactly `
      + `how the first opacity spinner failed. Each wedge must fade IN over roughly the `
      + `width of its neighbour so the head interpolates between them — a keyframe that `
      + `goes straight to full opacity measures ~100x here.`).toBeLessThan(1.15);
  });
});
