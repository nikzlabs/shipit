#!/usr/bin/env node
/** Compare renderer main-thread costs for spinner implementations. */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..");
const seconds = Number(process.argv[2] ?? 8);
const appUrl = process.argv[3];

const css = fs.readFileSync(path.join(repo, "src/client/index.css"), "utf8");

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

const SPINNER_CSS = [
  ...Array.from({ length: 12 }, (_, i) => block(`@keyframes spoke-${i} `)),
  block(".spinner {"),
  block(".spinner > i {"),
  ...Array.from({ length: 12 }, (_, i) => block(`.spinner > i:nth-child(${i + 1}) `)),
].join("\n");

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

const BEFORE_CSS = `
@keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
svg { display:block; vertical-align:middle }
.spin-old { animation: spin 1s steps(10) infinite }`;
const beforeIcons = (n) => Array.from({ length: n }, () =>
  `<svg class="pending" width="16" height="16" viewBox="0 0 256 256"><path fill="#4af" d="M232 128a104 104 0 1 1-104-104"/></svg>`).join("");

const SPOKES = 12;
const afterSpinner = () => `<span class="spinner pending" style="width:16px;height:16px;color:#8b95a5">${
  Array.from({ length: SPOKES }, () => "<i></i>").join("")}</span>`;
const afterSpinners = (n) => Array.from({ length: n }, () => afterSpinner()).join("");

const SAME_CSS = `
@keyframes same-move { from { transform: translateX(0) } to { transform: translateX(12px) } }
@keyframes same-fade { from { opacity: 1 } to { opacity: 0.12 } }
.same { display:inline-block; width:16px; height:16px; background:#4af }`;
const sameTarget = (which) =>
  `<span class="same" style="animation: same-${which} 1s linear infinite"></span>`;

const DELAY_CSS = `
@keyframes delay-fade { from { opacity: 1 } to { opacity: 0.12 } }
.delay { position:relative; display:inline-block; width:16px; height:16px; color:#8b95a5 }
.delay > i { position:absolute; left:50%; top:50%; width:12%; height:26%; margin:-13% 0 0 -6%;
  border-radius:999px; background:currentColor;
  transform: rotate(calc(var(--i) * -30deg)) translateY(-140%);
  animation: delay-fade 1.2s linear infinite; animation-delay: calc(var(--i) * -0.1s) }`;
const delaySpinner = () => `<span class="delay">${
  Array.from({ length: SPOKES }, (_, k) => `<i style="--i:${k}"></i>`).join("")}</span>`;

const STAGGER = (cls) => `document.querySelectorAll('.pending')
  .forEach((el, i) => setTimeout(() => el.classList.add('${cls}'), i * 7));`;
const IMMEDIATE = (cls) => `document.querySelectorAll('.pending').forEach((el) => el.classList.add('${cls}'));`;
// The shipped spinner starts on mount, so stagger the mounts.
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
  // Use the app's spinner rules.
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
    // The trace names style recalculation `UpdateLayoutTree`.
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
