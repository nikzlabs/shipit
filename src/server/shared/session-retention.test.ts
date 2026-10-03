import { describe, it, expect } from "vitest";
import type { SessionInfo } from "./types.js";
import {
  DEFAULT_DATA_RETENTION,
  dataDeletionTimeMs,
  isUnderDataRetention,
  retainedDataSizeIsStale,
  retentionPeriodDays,
} from "./session-retention.js";

const DAY = 86_400_000;
const MB = 1024 * 1024;
const at = (iso: string) => Date.parse(iso);

const base: SessionInfo = {
  id: "s", title: "s", createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: "2026-01-01T00:00:00.000Z", remoteUrl: "",
};

const archived = (extra: Partial<SessionInfo> = {}): SessionInfo => ({
  ...base,
  userArchived: true,
  archived: true,
  archivedAt: "2026-03-01T00:00:00.000Z",
  retainedDataBytes: 5 * MB,
  retainedDataMeasuredAt: "2026-03-01T00:10:00.000Z",
  ...extra,
});

describe("retention period (req 3, req 13)", () => {
  it("is 60 days below 100 MB and 14 days from 100 MB", () => {
    expect(retentionPeriodDays(100 * MB - 1, DEFAULT_DATA_RETENTION)).toBe(60);
    expect(retentionPeriodDays(100 * MB, DEFAULT_DATA_RETENTION)).toBe(14);
  });

  it("gives a large session the normal period when the short period is off", () => {
    expect(retentionPeriodDays(500 * MB, { ...DEFAULT_DATA_RETENTION, largeDays: 0 })).toBe(60);
  });

  it("has no period at all when the normal period is 0", () => {
    expect(retentionPeriodDays(500 * MB, { ...DEFAULT_DATA_RETENTION, days: 0 })).toBe(0);
    expect(retentionPeriodDays(1, { ...DEFAULT_DATA_RETENTION, days: 0 })).toBe(0);
  });
});

describe("an archived session (req 4, req 5)", () => {
  it("is deleted one period after the archive time", () => {
    expect(dataDeletionTimeMs(archived(), false, DEFAULT_DATA_RETENTION))
      .toBe(at("2026-03-01T00:00:00.000Z") + 60 * DAY);
    expect(dataDeletionTimeMs(archived({ retainedDataBytes: 200 * MB }), false, DEFAULT_DATA_RETENTION))
      .toBe(at("2026-03-01T00:00:00.000Z") + 14 * DAY);
  });

  it("does not count from its last use", () => {
    const old = archived({ lastUsedAt: "2025-01-01T00:00:00.000Z" });
    expect(dataDeletionTimeMs(old, false, DEFAULT_DATA_RETENTION))
      .toBe(at("2026-03-01T00:00:00.000Z") + 60 * DAY);
  });

  it("has no date without an archive time, without files, or with the period off", () => {
    expect(dataDeletionTimeMs(archived({ archivedAt: undefined }), false, DEFAULT_DATA_RETENTION)).toBeUndefined();
    expect(dataDeletionTimeMs(archived({ retainedDataBytes: 0 }), false, DEFAULT_DATA_RETENTION)).toBeUndefined();
    expect(dataDeletionTimeMs(archived({ retainedDataBytes: undefined }), false, DEFAULT_DATA_RETENTION)).toBeUndefined();
    expect(dataDeletionTimeMs(archived(), false, { ...DEFAULT_DATA_RETENTION, days: 0 })).toBeUndefined();
  });

  it("has no date while its size is older than the archive time", () => {
    const stale = archived({ retainedDataMeasuredAt: "2026-02-01T00:00:00.000Z" });
    expect(retainedDataSizeIsStale(stale, false)).toBe(true);
    expect(dataDeletionTimeMs(stale, false, DEFAULT_DATA_RETENTION)).toBeUndefined();
  });
});

describe("a done session that is not archived (req 11, req 12)", () => {
  const done = (extra: Partial<SessionInfo> = {}): SessionInfo => ({
    ...base,
    mergedAt: "2026-03-05 12:00:00",
    lastUsedAt: "2026-03-04T00:00:00.000Z",
    retainedDataBytes: 5 * MB,
    retainedDataMeasuredAt: "2026-03-06T00:00:00.000Z",
    ...extra,
  });

  it("counts from the merge when that is later than the last use", () => {
    expect(dataDeletionTimeMs(done(), true, DEFAULT_DATA_RETENTION))
      .toBe(at("2026-03-05T12:00:00.000Z") + 60 * DAY);
  });

  it("counts from the last view when the user opened it after the merge", () => {
    const viewed = done({
      lastViewedAt: "2026-03-20T00:00:00.000Z",
      retainedDataMeasuredAt: "2026-03-20T01:00:00.000Z",
    });
    expect(dataDeletionTimeMs(viewed, true, DEFAULT_DATA_RETENTION))
      .toBe(at("2026-03-20T00:00:00.000Z") + 60 * DAY);
  });

  it("needs a new measurement after the user opened it", () => {
    expect(retainedDataSizeIsStale(done({ lastViewedAt: "2026-03-20T00:00:00.000Z" }), true)).toBe(true);
  });

  it("counts from the close of a pull request that was not merged", () => {
    const closed = done({ mergedAt: undefined, closedAt: "2026-03-05T12:00:00.000Z" });
    expect(dataDeletionTimeMs(closed, true, DEFAULT_DATA_RETENTION))
      .toBe(at("2026-03-05T12:00:00.000Z") + 60 * DAY);
  });

  it("is not under retention when it is not done", () => {
    expect(isUnderDataRetention(done(), false)).toBe(false);
    expect(dataDeletionTimeMs(done(), false, DEFAULT_DATA_RETENTION)).toBeUndefined();
  });
});

describe("the floor for sessions older than the feature (req 5, req 12)", () => {
  it("starts no period before it", () => {
    const floor = "2026-10-01T00:00:00.000Z";
    const s = archived({ retentionFloorAt: floor, retainedDataMeasuredAt: floor });
    expect(dataDeletionTimeMs(s, false, DEFAULT_DATA_RETENTION)).toBe(at(floor) + 60 * DAY);
  });

  it("does not move a period that starts after it", () => {
    const s = archived({ retentionFloorAt: "2026-01-01T00:00:00.000Z" });
    expect(dataDeletionTimeMs(s, false, DEFAULT_DATA_RETENTION))
      .toBe(at("2026-03-01T00:00:00.000Z") + 60 * DAY);
  });
});
