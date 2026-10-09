import { describe, it, expect } from "vitest";
import {
  dueSlots,
  nextRuns,
  normalizeTimeZone,
  parseScheduleTiming,
  timingProblem,
  timingToCron,
} from "./schedule-timing.js";
import type { ScheduleTiming } from "./types.js";

const BERLIN = "Europe/Berlin";
// Its clock moves by 30 minutes: 02:00 → 02:30 on 2026-10-04, 02:00 → 01:30 on 2026-04-05.
const LORD_HOWE = "Australia/Lord_Howe";

const cron = (expression: string): ScheduleTiming => ({ kind: "cron", expression });
const at = (iso: string) => new Date(iso);
const iso = (dates: Date[]) => dates.map((d) => d.toISOString());
const local = (dates: Date[], timeZone: string) =>
  dates.map((d) => d.toLocaleString("sv-SE", { timeZone, dateStyle: "short", timeStyle: "short" }));

function schedule(timing: ScheduleTiming, timeZone: string, activeSince: string) {
  return { timing, timeZone, activeSince };
}

describe("presets (req 16)", () => {
  it("compile to cron", () => {
    expect(timingToCron({ kind: "hourly", minute: 15 })).toBe("15 * * * *");
    expect(timingToCron({ kind: "daily", hour: 9, minute: 0 })).toBe("0 9 * * *");
    expect(timingToCron({ kind: "weekdays", hour: 9, minute: 30 })).toBe("30 9 * * 1-5");
    expect(timingToCron({ kind: "weekly", weekday: 1, hour: 9, minute: 0 })).toBe("0 9 * * 1");
    expect(timingToCron(cron("  0 9 * * *  "))).toBe("0 9 * * *");
  });

  it("run when they say", () => {
    // 2026-10-09 is a Friday.
    expect(iso(nextRuns({ kind: "weekdays", hour: 9, minute: 0 }, "UTC", 2, at("2026-10-09T12:00:00Z"))))
      .toEqual(["2026-10-12T09:00:00.000Z", "2026-10-13T09:00:00.000Z"]);
    expect(iso(nextRuns({ kind: "weekly", weekday: 1, hour: 9, minute: 0 }, "UTC", 2, at("2026-10-07T12:00:00Z"))))
      .toEqual(["2026-10-12T09:00:00.000Z", "2026-10-19T09:00:00.000Z"]);
    expect(iso(nextRuns({ kind: "hourly", minute: 15 }, "UTC", 2, at("2026-10-07T09:20:00Z"))))
      .toEqual(["2026-10-07T10:15:00.000Z", "2026-10-07T11:15:00.000Z"]);
  });

  it("keep a run at 09:00 local time across both daylight-saving changes", () => {
    const daily = { kind: "daily", hour: 9, minute: 0 } as const;
    const spring = nextRuns(daily, BERLIN, 2, at("2026-03-28T00:00:00Z"));
    const autumn = nextRuns(daily, BERLIN, 2, at("2026-10-24T00:00:00Z"));
    expect(iso(spring)).toEqual(["2026-03-28T08:00:00.000Z", "2026-03-29T07:00:00.000Z"]);
    expect(iso(autumn)).toEqual(["2026-10-24T07:00:00.000Z", "2026-10-25T08:00:00.000Z"]);
    expect(local([...spring, ...autumn], BERLIN).map((s) => s.slice(11))).toEqual(["09:00", "09:00", "09:00", "09:00"]);
  });
});

describe("due slots", () => {
  const daily = schedule({ kind: "daily", hour: 9, minute: 0 }, BERLIN, "2026-10-07T06:00:00.000Z");

  it("are none before the slot, and include a slot at exactly now", () => {
    expect(dueSlots(daily, null, at("2026-10-07T06:59:59.999Z"))).toBeNull();
    expect(dueSlots(daily, null, at("2026-10-07T07:00:00.000Z"))).toEqual({ latest: at("2026-10-07T07:00:00Z") });
  });

  it("do not include a slot already claimed", () => {
    expect(dueSlots(daily, "2026-10-07T07:00:00.000Z", at("2026-10-07T12:00:00Z"))).toBeNull();
  });

  it("do not include a slot at the moment the schedule became active", () => {
    const fromSlot = schedule(daily.timing, BERLIN, "2026-10-07T07:00:00.000Z");
    expect(dueSlots(fromSlot, null, at("2026-10-07T07:30:00Z"))).toBeNull();
  });

  it("run only the latest after a downtime and summarize the missed ones (req 15)", () => {
    const s = schedule(daily.timing, BERLIN, "2026-10-01T06:00:00.000Z");
    expect(dueSlots(s, "2026-10-03T07:00:00.000Z", at("2026-10-07T12:00:00Z"))).toEqual({
      latest: at("2026-10-07T07:00:00Z"),
      missed: { count: 3, first: at("2026-10-04T07:00:00Z"), last: at("2026-10-06T07:00:00Z") },
    });
  });

  it("start from activeSince when it is later than the last slot, so a paused stretch does not run", () => {
    const resumed = schedule(daily.timing, BERLIN, "2026-10-06T08:00:00.000Z");
    expect(dueSlots(resumed, "2026-10-03T07:00:00.000Z", at("2026-10-07T12:00:00Z")))
      .toEqual({ latest: at("2026-10-07T07:00:00Z") });
  });

  it("throw on a timing that timingProblem refuses", () => {
    expect(() => dueSlots(schedule(cron("hello"), "UTC", "2026-10-07T00:00:00Z"), null)).toThrow();
    expect(() => nextRuns(cron("0 9 * * *"), "Mars/Olympus", 1)).toThrow();
  });
});

describe("daylight-saving days (req 29)", () => {
  describe("Berlin, spring: 02:00 → 03:00 on 2026-03-29", () => {
    const at0230 = schedule({ kind: "daily", hour: 2, minute: 30 }, BERLIN, "2026-03-28T00:00:00.000Z");

    it("runs a missing 02:30 one hour later, at 03:30", () => {
      const runs = nextRuns(at0230.timing, BERLIN, 3, at("2026-03-28T00:00:00Z"));
      expect(local(runs, BERLIN)).toEqual(["2026-03-28 02:30", "2026-03-29 03:30", "2026-03-30 02:30"]);
    });

    it("does not report the 03:30 slot as due at 03:00, which previousRuns does", () => {
      expect(dueSlots(at0230, null, at("2026-03-29T01:00:00Z"))).toEqual({ latest: at("2026-03-28T01:30:00Z") });
      expect(dueSlots(at0230, "2026-03-28T01:30:00.000Z", at("2026-03-29T01:30:00Z")))
        .toEqual({ latest: at("2026-03-29T01:30:00Z") });
    });

    it("still runs the moved 03:30 when the walk starts after the change, at 03:10", () => {
      expect(iso(nextRuns(at0230.timing, BERLIN, 1, at("2026-03-29T01:10:00Z")))).toEqual(["2026-03-29T01:30:00.000Z"]);
      const lateStart = schedule(at0230.timing, BERLIN, "2026-03-29T01:10:00.000Z");
      expect(dueSlots(lateStart, null, at("2026-03-29T02:00:00Z"))).toEqual({ latest: at("2026-03-29T01:30:00Z") });
    });

    // Croner's own nextRuns lists 03:30 twice here.
    it("keeps an hourly schedule one hour apart, with nothing at 02:30 and 03:30 once", () => {
      const runs = nextRuns({ kind: "hourly", minute: 30 }, BERLIN, 4, at("2026-03-28T23:00:00Z"));
      expect(local(runs, BERLIN)).toEqual(["2026-03-29 00:30", "2026-03-29 01:30", "2026-03-29 03:30", "2026-03-29 04:30"]);
      expect(iso(runs)).toEqual([
        "2026-03-28T23:30:00.000Z",
        "2026-03-29T00:30:00.000Z",
        "2026-03-29T01:30:00.000Z",
        "2026-03-29T02:30:00.000Z",
      ]);
    });
  });

  describe("Berlin, autumn: 03:00 → 02:00 on 2026-10-25", () => {
    const at0230 = schedule({ kind: "daily", hour: 2, minute: 30 }, BERLIN, "2026-10-24T12:00:00.000Z");

    it("runs a twice-occurring 02:30 once", () => {
      expect(iso(nextRuns(at0230.timing, BERLIN, 2, at("2026-10-24T12:00:00Z"))))
        .toEqual(["2026-10-25T00:30:00.000Z", "2026-10-26T01:30:00.000Z"]);
      expect(dueSlots(at0230, null, at("2026-10-25T03:00:00Z"))).toEqual({ latest: at("2026-10-25T00:30:00Z") });
      expect(dueSlots(at0230, "2026-10-25T00:30:00.000Z", at("2026-10-25T23:00:00Z"))).toBeNull();
    });

    it("does not run the second 02:30 when the walk starts between the two", () => {
      expect(dueSlots(at0230, "2026-10-24T00:30:00.000Z", at("2026-10-25T03:00:00Z")))
        .toEqual({ latest: at("2026-10-25T00:30:00Z") });
      const between = schedule(at0230.timing, BERLIN, "2026-10-25T00:45:00.000Z");
      expect(dueSlots(between, null, at("2026-10-25T23:00:00Z"))).toBeNull();
    });

    it("never gives a slot before a walk that starts inside the repeated hour", () => {
      // 02:10 CET: the first 02:30 (CEST) came 40 minutes earlier.
      const inRepeatedHour = schedule(at0230.timing, BERLIN, "2026-10-25T01:10:00.000Z");
      expect(dueSlots(inRepeatedHour, null, at("2026-10-25T01:20:00Z"))).toBeNull();
      expect(iso(nextRuns(at0230.timing, BERLIN, 1, at("2026-10-25T01:10:00Z")))).toEqual(["2026-10-26T01:30:00.000Z"]);
    });

    it("runs an hourly 02:30 once, then 03:30 two hours later", () => {
      const runs = nextRuns({ kind: "hourly", minute: 30 }, BERLIN, 4, at("2026-10-24T22:00:00Z"));
      expect(local(runs, BERLIN)).toEqual(["2026-10-25 00:30", "2026-10-25 01:30", "2026-10-25 02:30", "2026-10-25 03:30"]);
      expect(iso(runs).slice(2)).toEqual(["2026-10-25T00:30:00.000Z", "2026-10-25T02:30:00.000Z"]);
    });
  });

  describe("Lord Howe Island, a 30-minute change", () => {
    it("runs a missing 02:15 thirty minutes later, at 02:45, on 2026-10-04", () => {
      const runs = nextRuns({ kind: "daily", hour: 2, minute: 15 }, LORD_HOWE, 3, at("2026-10-02T00:00:00Z"));
      expect(local(runs, LORD_HOWE)).toEqual(["2026-10-03 02:15", "2026-10-04 02:45", "2026-10-05 02:15"]);
      expect(iso(runs)[1]).toBe("2026-10-03T15:45:00.000Z");
      // From 02:40, after the change.
      expect(iso(nextRuns({ kind: "daily", hour: 2, minute: 15 }, LORD_HOWE, 1, at("2026-10-03T15:40:00Z"))))
        .toEqual(["2026-10-03T15:45:00.000Z"]);
    });

    it("runs a twice-occurring 01:45 once on 2026-04-05", () => {
      const daily = { kind: "daily", hour: 1, minute: 45 } as const;
      const runs = nextRuns(daily, LORD_HOWE, 3, at("2026-04-03T00:00:00Z"));
      expect(local(runs, LORD_HOWE)).toEqual(["2026-04-04 01:45", "2026-04-05 01:45", "2026-04-06 01:45"]);
      // The day's run is the second 01:45 (+10:30); after it, the next is the following day.
      expect(iso(runs)[1]).toBe("2026-04-04T15:15:00.000Z");
      expect(iso(nextRuns(daily, LORD_HOWE, 1, at("2026-04-04T15:15:00Z")))).toEqual(["2026-04-05T15:15:00.000Z"]);
    });
  });

  it("from any start near a change, gives runs after the start, in order, and a daily time once a day", () => {
    const changes = [
      { zone: BERLIN, at: "2026-03-29T01:00:00Z" },
      { zone: BERLIN, at: "2026-10-25T01:00:00Z" },
      { zone: LORD_HOWE, at: "2026-10-03T15:30:00Z" },
      { zone: LORD_HOWE, at: "2026-04-04T15:00:00Z" },
    ];
    const timings: ScheduleTiming[] = [
      { kind: "daily", hour: 2, minute: 15 },
      { kind: "daily", hour: 1, minute: 45 },
      { kind: "hourly", minute: 30 },
    ];
    for (const change of changes) {
      for (let minutes = -120; minutes <= 120; minutes += 10) {
        const start = new Date(Date.parse(change.at) + minutes * 60_000);
        for (const timing of timings) {
          const runs = nextRuns(timing, change.zone, 3, start);
          const where = `${change.zone} from ${start.toISOString()}, ${timingToCron(timing)}`;
          expect(runs[0].getTime(), where).toBeGreaterThan(start.getTime());
          for (let i = 1; i < runs.length; i++) expect(runs[i].getTime(), where).toBeGreaterThan(runs[i - 1].getTime());
          if (timing.kind === "daily") {
            const days = local(runs, change.zone).map((s) => s.slice(0, 10));
            expect(new Set(days).size, where).toBe(days.length);
          }
        }
      }
    }
  });
});

describe("timingProblem", () => {
  const NOW = at("2026-10-07T06:10:00Z");

  it("accepts the presets and a cron expression", () => {
    for (const timing of [
      { kind: "hourly", minute: 0 },
      { kind: "daily", hour: 23, minute: 59 },
      { kind: "weekdays", hour: 9, minute: 0 },
      { kind: "weekly", weekday: 6, hour: 9, minute: 0 },
      cron("0 9 * * 1-5"),
      cron("@daily"),
    ] satisfies ScheduleTiming[]) {
      expect(timingProblem(timing, BERLIN, NOW)).toBeNull();
    }
  });

  it("refuses an unknown zone and a fixed offset", () => {
    expect(timingProblem(cron("0 9 * * *"), "Mars/Olympus", NOW)).toMatch(/Unknown time zone "Mars\/Olympus"/);
    expect(timingProblem(cron("0 9 * * *"), "+02:00", NOW)).toMatch(/Unknown time zone/);
  });

  it("refuses preset values out of range", () => {
    expect(timingProblem({ kind: "hourly", minute: 60 }, BERLIN, NOW)).toMatch(/minute/);
    expect(timingProblem({ kind: "hourly", minute: 1.5 }, BERLIN, NOW)).toMatch(/minute/);
    expect(timingProblem({ kind: "daily", hour: 24, minute: 0 }, BERLIN, NOW)).toMatch(/hour/);
    expect(timingProblem({ kind: "weekly", weekday: 7, hour: 9, minute: 0 }, BERLIN, NOW)).toMatch(/weekday/);
  });

  it("refuses what is not a five-field cron expression, a date included", () => {
    expect(timingProblem(cron("  "), BERLIN, NOW)).toMatch(/empty/);
    expect(timingProblem(cron("hello"), BERLIN, NOW)).toMatch(/is not a cron expression/);
    expect(timingProblem(cron("0 0 9 * * *"), BERLIN, NOW)).toMatch(/is not a cron expression/);
    expect(timingProblem(cron("2026-10-08T09:00:00"), BERLIN, NOW)).toMatch(/is not a cron expression/);
  });

  it("refuses a timing that never runs", () => {
    expect(timingProblem(cron("0 9 30 2 *"), BERLIN, NOW)).toBe('"0 9 30 2 *" never runs.');
  });

  describe("one hour apart (req 17)", () => {
    it("accepts runs exactly an hour apart", () => {
      expect(timingProblem(cron("0 * * * *"), BERLIN, NOW)).toBeNull();
      expect(timingProblem(cron("0 9,10 * * *"), BERLIN, NOW)).toBeNull();
    });

    it("refuses runs less than an hour apart, naming two of them as the schedule gives them", () => {
      expect(timingProblem(cron("*/30 * * * *"), BERLIN, NOW)).toBe(
        "Runs must be at least an hour apart, but two come 30 minutes apart, at 06:30 and 07:00.",
      );
      expect(timingProblem(cron("0,30 9 * * *"), BERLIN, NOW))
        .toMatch(/30 minutes apart, at 09:00 and 09:30\.$/);
      expect(timingProblem(cron("59 8 * * *"), BERLIN, NOW)).toBeNull();
      expect(timingProblem(cron("0,59 8 * * *"), BERLIN, NOW)).toMatch(/59 minutes apart/);
    });

    it("accepts an hourly schedule across Berlin's changes, which keep it an hour apart", () => {
      expect(timingProblem({ kind: "hourly", minute: 30 }, BERLIN, at("2026-03-28T22:00:00Z"))).toBeNull();
      expect(timingProblem({ kind: "hourly", minute: 30 }, BERLIN, at("2026-10-24T22:00:00Z"))).toBeNull();
    });

    // 2026-10-07 decision: the hour ignores clock changes, so Lord Howe Island's moved 02:30
    // may come 30 minutes before 03:00; the overlap rule (req 14) still guards that day.
    it("ignores Lord Howe Island's 30-minute change, accepting a timing the same on every date", () => {
      for (const timing of [cron("0 2,3 * * *"), { kind: "hourly", minute: 15 }] satisfies ScheduleTiming[]) {
        for (const now of [at("2026-10-02T00:00:00Z"), at("2026-04-03T00:00:00Z"), NOW]) {
          expect(timingProblem(timing, LORD_HOWE, now)).toBeNull();
        }
      }
      // The missing 02:00 runs at 02:30, thirty minutes before 03:00.
      expect(iso(nextRuns(cron("0 2,3 * * *"), LORD_HOWE, 2, at("2026-10-03T14:00:00Z"))))
        .toEqual(["2026-10-03T15:30:00.000Z", "2026-10-03T16:00:00.000Z"]);
    });

    it("refuses a too-close timing the same on every date and in every zone", () => {
      for (const zone of [BERLIN, LORD_HOWE, "UTC", "America/New_York"]) {
        for (const now of [NOW, at("2026-03-29T00:30:00Z"), at("2026-10-04T00:00:00Z")]) {
          expect(timingProblem(cron("0,30 9 * * *"), zone, now)).toMatch(/30 minutes apart/);
        }
      }
    });
  });
});

describe("normalizeTimeZone", () => {
  it("gives the canonical name of an IANA zone and null for anything else", () => {
    expect(normalizeTimeZone("europe/berlin")).toBe("Europe/Berlin");
    expect(normalizeTimeZone("UTC")).toBe("UTC");
    expect(normalizeTimeZone("+01:00")).toBeNull();
    expect(normalizeTimeZone("-0500")).toBeNull();
    expect(normalizeTimeZone("Mars/Olympus")).toBeNull();
    expect(normalizeTimeZone("")).toBeNull();
  });
});

describe("parseScheduleTiming", () => {
  it("reads each timing kind and drops unknown keys", () => {
    for (const timing of [
      { kind: "hourly", minute: 5 },
      { kind: "daily", hour: 9, minute: 0 },
      { kind: "weekdays", hour: 9, minute: 0 },
      { kind: "weekly", weekday: 1, hour: 9, minute: 0 },
      cron("0 9 * * *"),
    ] satisfies ScheduleTiming[]) {
      expect(parseScheduleTiming(JSON.parse(JSON.stringify(timing)))).toEqual(timing);
    }
    expect(parseScheduleTiming({ kind: "hourly", minute: 5, extra: true })).toEqual({ kind: "hourly", minute: 5 });
  });

  it("gives null for what is not a timing", () => {
    for (const value of [null, "daily", 9, { kind: "daily", hour: "9", minute: 0 }, { kind: "cron" }, { kind: "monthly", day: 1 }]) {
      expect(parseScheduleTiming(value)).toBeNull();
    }
  });
});
