import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import os from "node:os";
import { beatSlices, buildFilter, buildPlan, keptSeconds, mergeSlices, planSlices } from "./cut-plan.mjs";

/**
 * The slice math of docs/296 plan §5: per beat keep [actionAt, actionAt+lead]
 * then [readyAt, readyAt+hold], merged when they overlap; a beat with no action
 * starts where the previous hold ends; nothing before the first action; `lead: 0`
 * is the instant case (req 12).
 */
const HERE = dirname(fileURLToPath(import.meta.url));

const storyboard = (beats: { id: string; lead: number; hold: number }[]) => ({ beats });

describe("planSlices", () => {
  it("keeps lead then hold per beat and drops everything before the first action", () => {
    const beats = [
      { id: "prompt", actionAt: 10, readyAt: 30 },
      { id: "merge", actionAt: 50, readyAt: 70 },
    ];
    const plan = planSlices(beats, storyboard([{ id: "prompt", lead: 4, hold: 1 }, { id: "merge", lead: 3, hold: 4 }]));
    expect(plan).toEqual([
      { start: 10, end: 14 },
      { start: 30, end: 31 },
      { start: 50, end: 53 },
      { start: 70, end: 74 },
    ]);
    expect(keptSeconds(plan)).toBe(12);
  });

  it("merges the lead and hold of one beat when the result is ready inside the lead", () => {
    const plan = planSlices(
      [{ id: "session", actionAt: 10, readyAt: 12 }],
      storyboard([{ id: "session", lead: 4, hold: 1 }]),
    );
    // [10,14] and [12,13] overlap: one slice, not five seconds of footage.
    expect(plan).toEqual([{ start: 10, end: 14 }]);
  });

  it("merges a hold into the next beat's action when the driver acts inside the hold", () => {
    const plan = planSlices(
      [
        { id: "a", actionAt: 0, readyAt: 5 },
        { id: "b", actionAt: 7, readyAt: 20 },
      ],
      storyboard([{ id: "a", lead: 1, hold: 4 }, { id: "b", lead: 2, hold: 1 }]),
    );
    // a's hold [5,9] overlaps b's lead [7,9]: the cut stays continuous across the beat boundary.
    expect(plan).toEqual([
      { start: 0, end: 1 },
      { start: 5, end: 9 },
      { start: 20, end: 21 },
    ]);
  });

  it("starts a beat with no action where the previous hold ends", () => {
    const beats = [
      { id: "prompt", actionAt: 10, readyAt: 12 },
      { id: "work", actionAt: null, readyAt: 90 },
    ];
    const raw = beatSlices(beats, storyboard([{ id: "prompt", lead: 4, hold: 1 }, { id: "work", lead: 6, hold: 6 }]).beats);
    expect(raw).toEqual([
      { beat: "prompt", part: "lead", start: 10, end: 14 },
      { beat: "prompt", part: "hold", start: 12, end: 13 },
      // previous hold ends at 13, so the work footage is [13, 19]
      { beat: "work", part: "lead", start: 13, end: 19 },
      { beat: "work", part: "hold", start: 90, end: 96 },
    ]);
    // Merged: the prompt's lead absorbs its hold and abuts the work lead exactly.
    expect(mergeSlices(raw)).toEqual([
      { start: 10, end: 19 },
      { start: 90, end: 96 },
    ]);
  });

  it("lead 0 is the instant case: only the hold survives, so the wait is gone", () => {
    const plan = planSlices(
      [{ id: "new-session", actionAt: 3, readyAt: 65.5 }],
      storyboard([{ id: "new-session", lead: 0, hold: 1 }]),
    );
    expect(plan).toEqual([{ start: 65.5, end: 66.5 }]);
    expect(keptSeconds(plan)).toBe(1);
  });

  it("reproduces the website-hero storyboard's 36 kept seconds (plan §6)", () => {
    const story = storyboard([
      { id: "new-session", lead: 0, hold: 1 },
      { id: "prompt-1", lead: 4, hold: 1 },
      { id: "work", lead: 6, hold: 6 },
      { id: "prompt-2", lead: 5, hold: 6 },
      { id: "merge", lead: 3, hold: 4 },
    ]);
    const beats = [
      { id: "new-session", actionAt: 2, readyAt: 80 },
      { id: "prompt-1", actionAt: 85, readyAt: 90 },
      { id: "work", actionAt: null, readyAt: 200 },
      { id: "prompt-2", actionAt: 210, readyAt: 300 },
      { id: "merge", actionAt: 310, readyAt: 330 },
    ];
    expect(keptSeconds(planSlices(beats, story))).toBe(36);
  });

  it("rejects a log the storyboard cannot explain", () => {
    expect(() => planSlices([{ id: "x", actionAt: null, readyAt: 5 }], storyboard([{ id: "x", lead: 1, hold: 1 }]))).toThrow(
      /first beat .* has no action/,
    );
    expect(() => planSlices([{ id: "x", actionAt: 5, readyAt: 4 }], storyboard([{ id: "x", lead: 1, hold: 1 }]))).toThrow(
      /ready .* before its action/,
    );
    expect(() => planSlices([{ id: "x", actionAt: 1, readyAt: 4 }], storyboard([{ id: "y", lead: 1, hold: 1 }]))).toThrow(
      /not in the storyboard/,
    );
    expect(() => planSlices([{ id: "x", actionAt: 1, readyAt: 4 }], storyboard([{ id: "x", lead: -1, hold: 1 }]))).toThrow(
      /lead must be a non-negative number/,
    );
    expect(() => planSlices([{ id: "x", actionAt: 1, readyAt: 4 }], storyboard([{ id: "x", lead: 0, hold: 0 }]))).toThrow(
      /keeps nothing/,
    );
  });
});

describe("buildFilter", () => {
  it("trims each slice, rebases its timestamps and concatenates into [v]", () => {
    expect(buildFilter([{ start: 10, end: 14 }, { start: 30.25, end: 31 }])).toBe(
      "[0:v]trim=start=10:end=14,setpts=PTS-STARTPTS[s0];[0:v]trim=start=30.25:end=31,setpts=PTS-STARTPTS[s1];[s0][s1]concat=n=2:v=1:a=0[v]",
    );
  });

  it("is a one-input concat for a single slice", () => {
    expect(buildFilter([{ start: 0, end: 1 }])).toBe("[0:v]trim=start=0:end=1,setpts=PTS-STARTPTS[s0];[s0]concat=n=1:v=1:a=0[v]");
  });
});

describe("cut-plan.mjs CLI", () => {
  it("prints the plan as JSON, or just the filter or kept seconds", () => {
    const dir = mkdtempSync(join(os.tmpdir(), "cut-plan-"));
    try {
      const beats = join(dir, "beats.json");
      const story = join(dir, "storyboard.json");
      writeFileSync(beats, JSON.stringify([{ id: "a", actionAt: 1, readyAt: 3 }]));
      writeFileSync(story, JSON.stringify(storyboard([{ id: "a", lead: 1, hold: 2 }])));
      const run = (...extra: string[]) =>
        execFileSync(process.execPath, [join(HERE, "cut-plan.mjs"), beats, story, ...extra], { encoding: "utf8" });
      expect(JSON.parse(run()) as unknown).toEqual(buildPlan([{ id: "a", actionAt: 1, readyAt: 3 }], storyboard([{ id: "a", lead: 1, hold: 2 }])));
      expect(run("--print", "filter").trim()).toBe(
        "[0:v]trim=start=1:end=2,setpts=PTS-STARTPTS[s0];[0:v]trim=start=3:end=5,setpts=PTS-STARTPTS[s1];[s0][s1]concat=n=2:v=1:a=0[v]",
      );
      expect(run("--print", "kept").trim()).toBe("3");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("anchorBeats", () => {
  const log = [
    { id: "a", actionAt: 2.3, readyAt: 4.2 },
    { id: "b", actionAt: null, readyAt: 82.35 },
  ];
  const story = { beats: [{ id: "a", lead: 0, hold: 1 }, { id: "b", lead: 0, hold: 3 }] };

  it("shifts every stamp by wall − video, so the last hold lands inside the file", () => {
    // Measured shape: the driver's wall clock ran 85.6 s, the file is 83.24 s,
    // so the first frame was 2.36 s late and every stamp is that much early
    // in the video's own time.
    const plan = buildPlan(log, story, { wallDuration: 85.6, videoDuration: 83.24 });
    const last = plan.slices[plan.slices.length - 1];
    expect(last.start).toBeCloseTo(82.35 - 2.36, 2);
    expect(last.end).toBeLessThanOrEqual(83.24);
    expect(plan.keptSeconds).toBeCloseTo(4, 2);
  });

  it("leaves the stamps alone without an anchor, and clamps to the video end with one", () => {
    const unanchored = buildPlan(log, story);
    expect(unanchored.slices[unanchored.slices.length - 1].end).toBeCloseTo(85.35, 3);
    const clamped = buildPlan(log, story, { wallDuration: 83.24, videoDuration: 83.24 });
    expect(clamped.slices[clamped.slices.length - 1].end).toBe(83.24);
  });

  it("refuses a video longer than the wall clock", () => {
    expect(() => buildPlan(log, story, { wallDuration: 80, videoDuration: 83.24 })).toThrow(/longer than the wall clock/);
  });
});
