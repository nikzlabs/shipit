#!/usr/bin/env node
// Calibrates the cut's anchor (docs/296 plan §4): records a page that shows a
// black splash, flips white, then alternates red and blue once a second and
// ends black, each flip stamped on the driver's clock. Compare the stamps
// with the video (blackdetect for the splashes, signalstats for the colours)
// to see how far Playwright's video clock sits from Date.now() at the head,
// through the run and at the tail.
//
//   PLAYWRIGHT_BROWSERS_PATH=… node scripts/demo-video/clock-probe.mjs <out-dir>
//
// Measured 2026-09-17 (probe in this session's container): every flip landed
// 0.09–0.13 s before its stamp on the video's clock — one frame at 25 fps,
// head, middle and tail alike — and the file ran 1.06 s past the close. So a
// paint the driver owns anchors within a frame, and the wall − video fallback
// is off by the tail padding.
import { chromium } from "playwright";
import fs from "node:fs";

const out = process.argv[2];
if (!out) {
  process.stderr.write("usage: clock-probe.mjs <out-dir>\n");
  process.exit(2);
}
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const size = { width: 640, height: 360 };
const context = await browser.newContext({ viewport: size, recordVideo: { dir: out, size } });
const t0 = Date.now();
const t = () => (Date.now() - t0) / 1000;
const page = await context.newPage();
const paint = (color) => page.evaluate((c) => {
  document.body.style.background = c;
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}, color);

const stamps = { pageCreated: t(), flips: [] };
await page.setContent('<body style="margin:0;background:#000"></body>');
await paint("#000");
await page.waitForTimeout(500);
stamps.whiteAt = t();
await paint("#fff");
await page.waitForTimeout(1500);
for (let i = 0; i < 12; i++) {
  const color = i % 2 === 0 ? "#f00" : "#00f";
  stamps.flips.push({ at: t(), color });
  await paint(color);
  await page.waitForTimeout(1000);
}
stamps.blackAt = t();
await paint("#000");
await page.waitForTimeout(800);
stamps.closeAt = t();
const video = page.video();
await context.close();
await browser.close();
stamps.path = await video.path();
fs.writeFileSync(`${out}/stamps.json`, JSON.stringify(stamps, null, 2) + "\n");
process.stdout.write(JSON.stringify(stamps, null, 2) + "\n");
