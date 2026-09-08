#!/usr/bin/env node
// Slice math for the cut step — docs/296 plan §5. Pure, so it is unit-testable;
// `cut.sh` is the thin ffmpeg wrapper around it.
//
// From the driver's beat log (`beats.json`: [{ id, actionAt, readyAt }], seconds
// from recording start; `actionAt` is null for a beat with no action) and the
// storyboard (`beats: [{ id, lead, hold }]`) it keeps, per beat,
//
//   [actionAt, actionAt + lead]   the action and the work in progress
//   [readyAt,  readyAt  + hold]   the result, held still
//
// merged when they overlap; a beat with no action starts where the previous
// hold ends; everything before the first action is dropped. `lead: 0` is the
// instant case (req 12): the frame after the click is the frame where the
// result is ready.
//
// Usage:
//   node cut-plan.mjs <beats.json> <storyboard.json>            # full plan as JSON
//   node cut-plan.mjs <beats.json> <storyboard.json> --print filter
//   node cut-plan.mjs <beats.json> <storyboard.json> --print kept

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Slices shorter than this are noise from float arithmetic, not footage. */
const EPSILON = 1e-6;

function assertNumber(value, what) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${what} must be a non-negative number, got ${JSON.stringify(value)}`);
  }
}

/**
 * Raw per-beat slices in beat order, before merging. Exposed for the tests;
 * `planSlices` is what the wrapper uses.
 */
export function beatSlices(beatLog, storyboardBeats) {
  if (!Array.isArray(beatLog) || beatLog.length === 0) throw new Error("beat log is empty");
  if (!Array.isArray(storyboardBeats)) throw new Error("storyboard has no beats array");
  const byId = new Map(storyboardBeats.map((b) => [b.id, b]));
  const slices = [];
  let previousHoldEnd = null;
  beatLog.forEach((beat, i) => {
    const story = byId.get(beat.id);
    if (!story) throw new Error(`beat ${JSON.stringify(beat.id)} is in the beat log but not in the storyboard`);
    assertNumber(story.lead, `storyboard beat ${beat.id} lead`);
    assertNumber(story.hold, `storyboard beat ${beat.id} hold`);
    assertNumber(beat.readyAt, `beat ${beat.id} readyAt`);

    let actionAt;
    if (beat.actionAt === null || beat.actionAt === undefined) {
      if (i === 0) throw new Error(`the first beat (${beat.id}) has no action; there is nothing to start the cut from`);
      actionAt = previousHoldEnd;
    } else {
      assertNumber(beat.actionAt, `beat ${beat.id} actionAt`);
      if (beat.readyAt < beat.actionAt) {
        throw new Error(`beat ${beat.id} is ready (${beat.readyAt}s) before its action (${beat.actionAt}s)`);
      }
      actionAt = beat.actionAt;
    }

    slices.push({ beat: beat.id, part: "lead", start: actionAt, end: actionAt + story.lead });
    slices.push({ beat: beat.id, part: "hold", start: beat.readyAt, end: beat.readyAt + story.hold });
    previousHoldEnd = beat.readyAt + story.hold;
  });
  return slices;
}

/** Union of the raw slices as sorted, non-overlapping, non-empty intervals. */
export function mergeSlices(slices) {
  const sorted = slices.filter((s) => s.end - s.start > EPSILON).sort((a, b) => a.start - b.start);
  const merged = [];
  for (const s of sorted) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end + EPSILON) {
      last.end = Math.max(last.end, s.end);
    } else {
      merged.push({ start: s.start, end: s.end });
    }
  }
  return merged;
}

export function planSlices(beatLog, storyboard) {
  const merged = mergeSlices(beatSlices(beatLog, storyboard.beats));
  if (merged.length === 0) throw new Error("the plan keeps nothing: every lead and hold is zero");
  return merged;
}

/** ffmpeg `-filter_complex` graph: trim each slice, rebase its timestamps, concatenate into [v]. */
export function buildFilter(slices) {
  const fmt = (n) => Number(n.toFixed(3)).toString();
  const trims = slices.map((s, i) => `[0:v]trim=start=${fmt(s.start)}:end=${fmt(s.end)},setpts=PTS-STARTPTS[s${i}]`);
  const inputs = slices.map((_, i) => `[s${i}]`).join("");
  return `${trims.join(";")};${inputs}concat=n=${slices.length}:v=1:a=0[v]`;
}

export function keptSeconds(slices) {
  return Number(slices.reduce((sum, s) => sum + (s.end - s.start), 0).toFixed(3));
}

/**
 * Re-anchor the beat log onto the video's own clock.
 *
 * The driver stamps beats from the moment it opened the page, but Playwright's
 * first frame lands later — ~2 s, measured on the dogfood runs, not the
 * sub-100 ms the plan first assumed — so every stamp is late by the gap. The
 * video ends when the context closes, so the gap is exactly
 * `wallDuration − videoDuration`, and shifting every stamp by it lands the
 * last hold inside the file instead of past its end.
 */
export function anchorBeats(beatLog, { wallDuration, videoDuration } = {}) {
  if (!Number.isFinite(wallDuration) || !Number.isFinite(videoDuration)) return beatLog;
  const offset = wallDuration - videoDuration;
  if (offset < 0) throw new Error(`video (${videoDuration}s) is longer than the wall clock (${wallDuration}s)`);
  const shift = (t) => (t === null || t === undefined ? t : Math.max(0, t - offset));
  return beatLog.map((b) => ({ ...b, actionAt: shift(b.actionAt), readyAt: shift(b.readyAt) }));
}

export function buildPlan(beatLog, storyboard, anchor = {}) {
  const clampTo = Number.isFinite(anchor.videoDuration) ? anchor.videoDuration : Infinity;
  const slices = planSlices(anchorBeats(beatLog, anchor), storyboard)
    .map((s) => ({ start: Number(s.start.toFixed(3)), end: Number(Math.min(s.end, clampTo).toFixed(3)) }))
    .filter((s) => s.end > s.start);
  if (slices.length === 0) throw new Error("the plan keeps nothing inside the video");
  return { slices, keptSeconds: keptSeconds(slices), filter: buildFilter(slices) };
}

function main(argv) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const print = flag("--print");
  const wallDuration = flag("--wall-duration");
  const videoDuration = flag("--video-duration");
  const consumed = new Set([print, wallDuration, videoDuration].filter((v) => v !== undefined));
  const positional = argv.filter((a) => !a.startsWith("--") && !consumed.has(a));
  if (positional.length !== 2) {
    process.stderr.write("usage: cut-plan.mjs <beats.json> <storyboard.json> [--print filter|kept] [--wall-duration <s> --video-duration <s>]\n");
    process.exit(2);
  }
  const [beatsFile, storyboardFile] = positional;
  const plan = buildPlan(
    JSON.parse(fs.readFileSync(beatsFile, "utf8")),
    JSON.parse(fs.readFileSync(storyboardFile, "utf8")),
    { wallDuration: Number(wallDuration), videoDuration: Number(videoDuration) },
  );
  if (print === "filter") process.stdout.write(plan.filter + "\n");
  else if (print === "kept") process.stdout.write(String(plan.keptSeconds) + "\n");
  else if (print) {
    process.stderr.write(`unknown --print target: ${print}\n`);
    process.exit(2);
  } else process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`cut-plan: ${err.message}\n`);
    process.exit(1);
  }
}
