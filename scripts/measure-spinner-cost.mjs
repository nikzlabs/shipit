#!/usr/bin/env node
/**
 * What a page full of spinners costs the renderer main thread — the A/B behind
 * the docs/265 animation rule.
 *
 * The rule the first pass shipped ("an infinite animation must be a stepped
 * transform, at about 10 Hz") turned out to be wrong on both counts: a 10 fps
 * spinner is visibly choppy, and stepping did not even hold the rate, because
 * step boundaries run from each animation's own start time. This script is what
 * establishes the replacement — an OPACITY animation, unstepped and smooth,
 * costs zero main-thread frames however many of them run.
 *
 * It builds pages that differ in one thing at a time, traces each with
 * `trace-idle-frames.mjs`, and prints the table:
 *
 *   before-one       one stepped-transform spinner   (the old rule, best case)
 *   before-many      twelve, mounted 7 ms apart      (the old rule, real case)
 *   after-one        one opacity spinner
 *   after-many       twelve, mounted 7 ms apart
 *   same-transform   ONE element, transform, linear  ┐ the controlled pair: same
 *   same-opacity     ONE element, opacity,   linear  ┘ target, only the property
 *   delay-phased     one spinner phased by animation-delay
 *   keyframe-phased  one spinner phased in its keyframes (what ships)
 *
 * The `same-*` pair is the one that carries the causal claim. The before/after
 * pair changes the element type as well as the property (an <svg> becomes a span
 * of twelve children), so on its own it establishes only "this replacement is
 * cheaper" — not "the property is why". The controlled pair animates the SAME
 * element with the SAME timing and differs in nothing but `transform` versus
 * `opacity`.
 *
 * The `*-phased` pair is the second finding: twelve animations sharing one phase
 * behave as one, twelve phases do not. It shows up here as a difference between
 * two spellings of pixel-identical output.
 *
 * WHAT THIS DOES NOT MEASURE. `beginMainThreadFramesPerSecond` and
 * `mainThreadBusyPerSecondMs` are the renderer MAIN THREAD only. The opacity
 * spinner deliberately draws MORE compositor frames than the stepped one (that
 * is what smooth means), so compositor, Viz and GPU work goes up, and a claim
 * about total processor or battery cost would need a process-wide trace this
 * script does not take.
 *
 * Usage:  node scripts/measure-spinner-cost.mjs [seconds] [appUrl]
 *
 * THE PHASED PAIR NEEDS A REAL APP. On these synthetic pages both spellings
 * measure 0 — the difference does not reproduce against a bare document, and it
 * did not reproduce at 1,500 content-visibility rows either. Against a running
 * ShipIt it is a factor of ten, repeatably. So pass `appUrl` (start the dogfood
 * service with `shipit service start dev` and use the address from
 * `shipit service list`) and the last two rows switch from the fixture to
 * markup injected into that page. Without a URL they are printed as a pair that
 * agrees, which is a real result about the fixture and NOT evidence that the
 * spelling does not matter.
 *
 * Read `beginMainThreadFramesPerSecond` as the cost. `drawFramesPerSecond` is
 * how smooth it looks: the whole point of the result is that "after" is HIGHER
 * on draw and ZERO on main. Absolute milliseconds are a container without a
 * GPU, so compare the columns, not the numbers.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..");
const seconds = Number(process.argv[2] ?? 8);
/** Optional running ShipIt to measure against; see the note on the phased pair. */
const appUrl = process.argv[3];

const css = fs.readFileSync(path.join(repo, "src/client/index.css"), "utf8");

/** Pull a top-level block (`@keyframes x { … }`, `.sel { … }`) out of the stylesheet. */
function block(header) {
  const start = css.search(new RegExp(header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  if (start === -1) throw new Error(`index.css no longer contains \`${header}\` — update this script`);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces after \`${header}\``);
}

// Twelve @keyframes (one phase each), the shared geometry rule, and the twelve
// per-spoke rules that pair an angle with a keyframes block.
const SPINNER_CSS = [
  ...Array.from({ length: 12 }, (_, i) => block(`@keyframes spoke-${i} `)),
  block(".spinner {"),
  block(".spinner > i {"),
  ...Array.from({ length: 12 }, (_, i) => block(`.spinner > i:nth-child(${i + 1}) `)),
].join("\n");

/** The 30 rows + observer that make a produced frame cost anything at all. */
const ROWS = Array.from({ length: 30 }, (_, i) => `<p class="cv">row ${i}</p>`).join("");
const OBSERVER = `const io = new IntersectionObserver(() => {});
document.querySelectorAll('p').forEach((e) => io.observe(e));
window.__io = io;`;

const page = (styles, markup, script = "") => `<!doctype html>
<html><head><meta charset="utf-8"><style>
body { background:#111; color:#eee; font:12px monospace; margin:0; padding:20px }
.cv { content-visibility:auto; contain-intrinsic-size:auto 40px }
${styles}
</style></head><body>
<div class="stage">${markup}</div>
${ROWS}
<script>${script}\n${OBSERVER}</script>
</body></html>`;

// ── before: the rule as docs/265 first shipped it ────────────────────────────
// A Phosphor icon is an <svg>, and `animate-spin` resolved to `spin 1s steps(10)`.
const BEFORE_CSS = `
@keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
svg { display:block; vertical-align:middle }
.spin-old { animation: spin 1s steps(10) infinite }`;
// The class goes on the <svg> itself, exactly as `animate-spin` did. Putting it
// on a wrapping inline <span> measures something else entirely: `transform` does
// not apply to an inline box, so the animation ticks on the main thread every
// frame and produces no compositor frame at all (draw 0, main 60).
const beforeIcons = (n) => Array.from({ length: n }, () =>
  `<svg class="pending" width="16" height="16" viewBox="0 0 256 256"><path fill="#4af" d="M232 128a104 104 0 1 1-104-104"/></svg>`).join("");

// ── after: the rules ShipIt actually ships, read out of index.css ─────────────
// Twelve spokes, mirroring components/Spinner.tsx (the policy test asserts the
// two agree on the count).
const SPOKES = 12;
const afterSpinner = () => `<span class="spinner pending" style="width:16px;height:16px;color:#8b95a5">${
  Array.from({ length: SPOKES }, () => "<i></i>").join("")}</span>`;
const afterSpinners = (n) => Array.from({ length: n }, () => afterSpinner()).join("");

// ── the controlled pair: one element, one timing, one property changed ───────
const SAME_CSS = `
@keyframes same-move { from { transform: translateX(0) } to { transform: translateX(12px) } }
@keyframes same-fade { from { opacity: 1 } to { opacity: 0.12 } }
.same { display:inline-block; width:16px; height:16px; background:#4af }`;
const sameTarget = (which) =>
  `<span class="same" style="animation: same-${which} 1s linear infinite"></span>`;

// ── the two spellings of the same pixels ─────────────────────────────────────
// `delay-phased` is the spelling anyone would reach for first: one keyframes,
// twelve spokes, phase supplied by a staggered negative `animation-delay`.
const DELAY_CSS = `
@keyframes delay-fade { from { opacity: 1 } to { opacity: 0.12 } }
.delay { position:relative; display:inline-block; width:16px; height:16px; color:#8b95a5 }
.delay > i { position:absolute; left:50%; top:50%; width:12%; height:26%; margin:-13% 0 0 -6%;
  border-radius:999px; background:currentColor;
  transform: rotate(calc(var(--i) * -30deg)) translateY(-140%);
  animation: delay-fade 1.2s linear infinite; animation-delay: calc(var(--i) * -0.1s) }`;
const delaySpinner = () => `<span class="delay">${
  Array.from({ length: SPOKES }, (_, k) => `<i style="--i:${k}"></i>`).join("")}</span>`;

/**
 * Mount them 7 ms apart. For the "before" case this is the whole difference
 * between the old rule's best case and its real one: independently mounted
 * stepped animations do not share a step train, so their wake-ups add. Spinners
 * appear whenever a request starts, which is never the same frame. The "after"
 * case is staggered the same way so the comparison is like for like.
 */
const STAGGER = (cls) => `document.querySelectorAll('.pending')
  .forEach((el, i) => setTimeout(() => el.classList.add('${cls}'), i * 7));`;
const IMMEDIATE = (cls) => `document.querySelectorAll('.pending').forEach((el) => el.classList.add('${cls}'));`;
// The shipped `.spinner` rules animate as soon as the class is present, so the
// "after" stagger is done by MOUNTING each spinner late rather than by adding a
// class to one already in the document.
const MOUNT_STAGGERED = `(() => {
  const stage = document.querySelector('.stage');
  const pending = [...stage.children];
  pending.forEach((el) => el.remove());
  pending.forEach((el, i) => setTimeout(() => stage.appendChild(el), i * 7));
})();`;

const CASES = {
  "before-one": page(BEFORE_CSS, beforeIcons(1), IMMEDIATE("spin-old")),
  "before-many": page(BEFORE_CSS, beforeIcons(12), STAGGER("spin-old")),
  "after-one": page(SPINNER_CSS, afterSpinners(1)),
  "after-many": page(SPINNER_CSS, afterSpinners(12), MOUNT_STAGGERED),
  "same-transform": page(SAME_CSS, sameTarget("move")),
  "same-opacity": page(SAME_CSS, sameTarget("fade")),
  ...(appUrl ? {} : {
    "delay-phased (fixture: no signal)": page(DELAY_CSS, delaySpinner()),
    "keyframe-phased (fixture: no signal)": page(SPINNER_CSS, afterSpinners(1)),
  }),
};

/**
 * The phased pair, injected into a real page. Written as `--eval` scripts for
 * `trace-idle-frames.mjs`, which runs them before it starts recording.
 */
const APP_CASES = !appUrl ? {} : {
  "delay-phased (app)": `(() => {
    const style = document.createElement("style");
    style.textContent = \`${DELAY_CSS}\`;
    document.head.appendChild(style);
    const s = document.createElement("span");
    s.className = "delay";
    s.style.cssText += ";position:fixed;left:8px;bottom:8px;z-index:99999";
    for (let k = 0; k < ${SPOKES}; k++) { const i = document.createElement("i"); i.style.setProperty("--i", String(k)); s.appendChild(i); }
    document.body.appendChild(s);
    return "delay-phased";
  })();`,
  // Markup only: this one uses the app's OWN `.spinner` rules, so it measures
  // what ships rather than a copy of it.
  "keyframe-phased (app)": `(() => {
    const s = document.createElement("span");
    s.className = "spinner";
    s.style.cssText = "position:fixed;left:8px;bottom:8px;z-index:99999;width:16px;height:16px;color:#8b95a5";
    for (let k = 0; k < ${SPOKES}; k++) s.appendChild(document.createElement("i"));
    document.body.appendChild(s);
    return "keyframe-phased";
  })();`,
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spinner-cost-"));
const rows = [];
for (const [name, html] of Object.entries(CASES)) {
  const file = path.join(dir, `${name}.html`);
  fs.writeFileSync(file, html);
  const out = execFileSync("node", [path.join(here, "trace-idle-frames.mjs"), `file://${file}`, String(seconds)],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const r = JSON.parse(out);
  rows.push({
    case: name,
    drawFps: r.drawFramesPerSecond,
    mainFps: r.beginMainThreadFramesPerSecond,
    busyMsPerS: r.mainThreadBusyPerSecondMs,
    visibleLayers: r.visibleLayers,
    // Style recalcs per main frame. DevTools calls this event
    // `ScheduleStyleRecalculation`; the raw trace name is `UpdateLayoutTree`,
    // and there is no event by the DevTools name to count. A ratio of ~1 is the
    // signature of an animation dragging the full lifecycle behind every frame.
    recalcsPerMainFrame: r.beginMainThreadFramesPerSecond
      ? +((r.events?.UpdateLayoutTree?.calls ?? 0)
        / (r.beginMainThreadFramesPerSecond * r.windowSeconds)).toFixed(2)
      : 0,
  });
}
for (const [name, injector] of Object.entries(APP_CASES)) {
  const file = path.join(dir, `${name.replace(/\W+/g, "-")}.js`);
  fs.writeFileSync(file, injector);
  const out = execFileSync("node", [path.join(here, "trace-idle-frames.mjs"), appUrl, String(seconds),
    "--settle=5000", `--eval=${file}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const r = JSON.parse(out);
  rows.push({
    case: name,
    drawFps: r.drawFramesPerSecond,
    mainFps: r.beginMainThreadFramesPerSecond,
    busyMsPerS: r.mainThreadBusyPerSecondMs,
    visibleLayers: r.visibleLayers,
    recalcsPerMainFrame: r.beginMainThreadFramesPerSecond
      ? +((r.events?.UpdateLayoutTree?.calls ?? 0)
        / (r.beginMainThreadFramesPerSecond * r.windowSeconds)).toFixed(2)
      : 0,
  });
}

console.table(rows);
fs.rmSync(dir, { recursive: true, force: true });
