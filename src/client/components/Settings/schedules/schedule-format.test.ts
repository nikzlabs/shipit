import { describe, expect, it } from "vitest";
import { browserTimeZone, formatRunTime, formatScheduleRunTime, otherZone } from "./schedule-format.js";

const AT = "2026-10-07T09:00:00.000Z";
const ZONE = browserTimeZone() === "Asia/Tokyo" ? "America/New_York" : "Asia/Tokyo";

describe("otherZone", () => {
  it("is the schedule's zone only when it is not the browser's", () => {
    expect(otherZone(browserTimeZone())).toBeNull();
    expect(otherZone(ZONE)).toBe(ZONE);
  });

  it("is null for a zone this browser does not know, so the time is never mislabelled", () => {
    expect(otherZone("Mars/Olympus_Mons")).toBeNull();
    expect(formatScheduleRunTime(AT, "Mars/Olympus_Mons")).toBe(formatRunTime(AT));
  });
});

describe("formatRunTime in a given zone", () => {
  /** The hour and minute part, which no locale writes differently with `hourCycle: "h23"`. */
  const clock = (at: string, zone: string) => /\d\d:\d\d/.exec(formatRunTime(at, zone))?.[0];
  const day = (at: string, zone: string) => /\b\d{1,2}\b/.exec(formatRunTime(at, zone).replace(/\d\d:\d\d/, ""))?.[0];

  it("moves the clock and, past midnight, the date", () => {
    expect(clock("2026-10-07T09:00:00.000Z", "Asia/Tokyo")).toBe("18:00");
    expect(clock("2026-10-07T20:00:00.000Z", "Asia/Tokyo")).toBe("05:00");
    expect(day("2026-10-07T20:00:00.000Z", "Asia/Tokyo")).toBe("8");
    expect(day("2026-10-07T20:00:00.000Z", "UTC")).toBe("7");
  });

  it("follows daylight saving: Berlin is UTC+1 in winter and UTC+2 in summer", () => {
    expect(clock("2026-03-29T00:30:00.000Z", "Europe/Berlin")).toBe("01:30");
    expect(clock("2026-03-29T01:30:00.000Z", "Europe/Berlin")).toBe("03:30");
  });
});

describe("formatScheduleRunTime", () => {
  it("gives the time in the schedule's zone and names that zone", () => {
    expect(formatScheduleRunTime(AT, ZONE)).toBe(`${formatRunTime(AT, ZONE)} (${ZONE})`);
    expect(formatScheduleRunTime(AT, browserTimeZone())).toBe(formatRunTime(AT));
  });
});
