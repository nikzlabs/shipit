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

  it("keeps the full lead + hold budget when the result is ready inside the lead", () => {
    const plan = planSlices(
      [{ id: "session", actionAt: 10, readyAt: 12 }],
      storyboard([{ id: "session", lead: 4, hold: 1 }]),
    );
    // The lead is [10,14]; the hold starts where the lead ends, not at readyAt,
    // so a fast beat still contributes exactly lead + hold (5 s), never less.
    expect(plan).toEqual([{ start: 10, end: 15 }]);
    expect(keptSeconds(plan)).toBe(5);
  });

  it("a type beat's lead is the last `lead` seconds before the send, so typing speed never moves the cut", () => {
    const story = storyboard([{ id: "prompt", type: "Build it", lead: 4, hold: 1 }]);
    const slow = beatSlices([{ id: "prompt", actionAt: 10, sentAt: 21, readyAt: 22 }], story.beats);
    const quick = beatSlices([{ id: "prompt", actionAt: 10, sentAt: 16, readyAt: 22 }], story.beats);
    expect(slow[0]).toEqual({ beat: "prompt", part: "lead", start: 17, end: 21 });
    expect(quick[0]).toEqual({ beat: "prompt", part: "lead", start: 12, end: 16 });
    // A log that is ready before its send is not a take.
    expect(() => beatSlices([{ id: "prompt", actionAt: 10, sentAt: 21, readyAt: 15 }], story.beats)).toThrow(/must lie between/);
    expect(() => beatSlices([{ id: "prompt", actionAt: 10, readyAt: 22 }], story.beats)).toThrow(/sentAt/);
  });

  it("refuses a type beat whose send comes sooner after the previous hold than its lead", () => {
    // Take 2 of website-hero (2026-09-17): a 77-character prompt typed in 3.8 s
    // under a 5 s lead put 1.18 s of the lead inside the previous hold, and the
    // merged cut came out 34.8 s instead of 36. The driver now pauses before
    // the send; a log without that pause is refused rather than cut short.
    const story = storyboard([{ id: "work", lead: 6, hold: 6 }, { id: "prompt", type: "Dark mode", lead: 5, hold: 6 }]);
    const early = [
      { id: "work", actionAt: 10, readyAt: 20 },
      { id: "prompt", actionAt: 26.01, sentAt: 29.8, readyAt: 80 },
    ];
    expect(() => beatSlices(early, story.beats)).toThrow(/prompt: its send at 29.8s is only 3.800s after the previous hold ended \(26s\), less than its lead \(5s\)/);
    const paused = [
      { id: "work", actionAt: 10, readyAt: 20 },
      { id: "prompt", actionAt: 26.01, sentAt: 31.01, readyAt: 80 },
    ];
    expect(keptSeconds(planSlices(paused, story))).toBe(23);
  });

  it("a fast beat costs the same as a slow one: Σ(lead + hold) is the budget either way", () => {
    const story = storyboard([{ id: "merge", lead: 3, hold: 4 }]);
    const fast = planSlices([{ id: "merge", actionAt: 100, readyAt: 102 }], story);
    const slow = planSlices([{ id: "merge", actionAt: 100, readyAt: 105 }], story);
    expect(keptSeconds(fast)).toBe(7);
    expect(keptSeconds(slow)).toBe(7);
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
      // ready at 12, inside the lead: the hold starts where the lead ends
      { beat: "prompt", part: "hold", start: 14, end: 15 },
      // previous hold ends at 15, so the work footage is [15, 21]
      { beat: "work", part: "lead", start: 15, end: 21 },
      { beat: "work", part: "hold", start: 90, end: 96 },
    ]);
    // Merged: lead, hold and the work lead abut exactly; nothing overlaps.
    expect(mergeSlices(raw)).toEqual([
      { start: 10, end: 21 },
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
    // A log that never reached a storyboard beat is an aborted take first …
    expect(() => planSlices([{ id: "x", actionAt: 1, readyAt: 4 }], storyboard([{ id: "y", lead: 1, hold: 1 }]))).toThrow(
      /stops before "y"/,
    );
    // … and a logged beat the storyboard does not know is rejected by the slice math itself.
    expect(() => beatSlices([{ id: "x", actionAt: 1, readyAt: 4 }], [{ id: "y", lead: 1, hold: 1 }])).toThrow(
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

describe("anchoring", () => {
  const log = [
    { id: "a", actionAt: 2.3, readyAt: 4.2 },
    { id: "b", actionAt: null, readyAt: 82.35 },
  ];
  const story = { beats: [{ id: "a", lead: 0, hold: 1 }, { id: "b", lead: 0, hold: 3 }] };

  it("shifts the slices by anchorWall − anchorVideo: the splash ended at 1.9 s on the driver's clock and 0.48 s into the file", () => {
    const plan = buildPlan(log, story, { anchorWall: 1.9, anchorVideo: 0.48, videoDuration: 90 });
    expect(plan.anchor).toEqual({ method: "blackdetect", offset: 1.42 });
    expect(plan.slices).toEqual([
      { start: 2.78, end: 3.78 },
      { start: 80.93, end: 83.93 },
    ]);
    expect(plan.keptSeconds).toBe(4);
  });

  it("shifts slices, not stamps: a lead that starts before the first frame is shortened, not slid", () => {
    // actionAt 2.3 lands at −0.7 on the video's clock. Shifting the stamp and
    // clamping it to 0 would keep [0, 4]; the footage that exists is [0, 3.3].
    const plan = buildPlan([{ id: "a", actionAt: 2.3, readyAt: 60 }], { beats: [{ id: "a", lead: 4, hold: 0 }] }, { anchorWall: 3, anchorVideo: 0, videoDuration: 70 });
    expect(plan.slices).toEqual([{ start: 0, end: 3.3 }]);
  });

  it("clamps to the video's end and drops a slice that lies entirely outside the file", () => {
    const plan = buildPlan(log, story, { anchorWall: 1.9, anchorVideo: 0.48, videoDuration: 82 });
    expect(plan.slices).toEqual([
      { start: 2.78, end: 3.78 },
      { start: 80.93, end: 82 },
    ]);
    expect(() => buildPlan(log, story, { anchorWall: 1.9, anchorVideo: 0.48, videoDuration: 2 })).toThrow(/keeps nothing inside the video/);
  });

  it("prefers the blackdetect anchor over wall − video when both are given", () => {
    const plan = buildPlan(log, story, { anchorWall: 1.9, anchorVideo: 0.48, wallDuration: 85.6, videoDuration: 83.24 });
    expect(plan.anchor.method).toBe("blackdetect");
    expect(plan.slices[0].start).toBe(2.78);
  });

  it("falls back to wall − video, which lands the last hold inside the file up to the tail padding", () => {
    // Measured shape: the driver's wall clock ran 85.6 s, the file is 83.24 s.
    const plan = buildPlan(log, story, { wallDuration: 85.6, videoDuration: 83.24 });
    expect(plan.anchor).toEqual({ method: "wall-duration", offset: 2.36 });
    const last = plan.slices[plan.slices.length - 1];
    expect(last.start).toBeCloseTo(82.35 - 2.36, 2);
    expect(last.end).toBeLessThanOrEqual(83.24);
    expect(plan.keptSeconds).toBeCloseTo(4, 2);
    expect(() => buildPlan(log, story, { wallDuration: 80, videoDuration: 83.24 })).toThrow(/longer than the wall clock/);
  });

  it("leaves the stamps alone without an anchor, and still clips to a known video end", () => {
    const unanchored = buildPlan(log, story);
    expect(unanchored.anchor).toEqual({ method: "none", offset: 0 });
    expect(unanchored.slices[unanchored.slices.length - 1].end).toBeCloseTo(85.35, 3);
    const clipped = buildPlan(log, story, { videoDuration: 83.24 });
    expect(clipped.slices[clipped.slices.length - 1].end).toBe(83.24);
  });

  it("reads the anchor flags on the CLI, and refuses half a pair", () => {
    const dir = mkdtempSync(join(os.tmpdir(), "cut-plan-anchor-"));
    try {
      const beats = join(dir, "beats.json");
      const storyFile = join(dir, "storyboard.json");
      writeFileSync(beats, JSON.stringify(log));
      writeFileSync(storyFile, JSON.stringify(story));
      const run = (...extra: string[]) =>
        execFileSync(process.execPath, [join(HERE, "cut-plan.mjs"), beats, storyFile, ...extra], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      const plan = JSON.parse(run("--anchor-wall", "1.9", "--anchor-video", "0.48", "--video-duration", "90")) as ReturnType<typeof buildPlan>;
      expect(plan.slices[0]).toEqual({ start: 2.78, end: 3.78 });
      expect(() => run("--anchor-wall", "1.9")).toThrow(/go together/);
      expect(() => run("--anchor-wall", "x", "--anchor-video", "0.48")).toThrow(/must be a number/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
