import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseManager } from "../shared/database.js";
import { SessionManager } from "./sessions.js";
import { ScheduleStore, type NewSchedule } from "./schedule-store.js";

let dbManager: DatabaseManager;
let store: ScheduleStore;

const T0 = "2026-10-07T08:00:00.000Z";
const T1 = "2026-10-07T09:00:00.000Z";

const SPEC = {
  target: { kind: "repo", repoUrl: "https://github.com/o/r" },
  params: { role: "reviewer", futureKey: [1, 2] },
  prompt: "Check current security PRs and merge them.",
};

function newSchedule(over: Partial<NewSchedule> = {}): NewSchedule {
  return {
    name: "Security PRs",
    timing: { kind: "daily", hour: 9, minute: 0 },
    timeZone: "Europe/Berlin",
    spec: SPEC,
    ...over,
  };
}

beforeEach(() => {
  dbManager = new DatabaseManager(":memory:");
  store = new ScheduleStore(dbManager);
});

afterEach(() => {
  dbManager.close();
});

describe("ScheduleStore — schedules", () => {
  it("round-trips a schedule, with the spec stored as opaque JSON", () => {
    const created = store.create(newSchedule(), T0);
    expect(created).toEqual({
      id: expect.any(String),
      name: "Security PRs",
      enabled: true,
      timing: { kind: "daily", hour: 9, minute: 0 },
      timeZone: "Europe/Berlin",
      spec: SPEC,
      activeSince: T0,
      createdAt: T0,
      updatedAt: T0,
    });
    expect(store.get(created.id)).toEqual(created);
  });

  it("returns null for a schedule it does not hold", () => {
    expect(store.get("missing")).toBeNull();
    expect(store.update("missing", { name: "x" })).toBeNull();
    expect(store.delete("missing")).toBe(false);
  });

  it("lists schedules in the order they were created", () => {
    const a = store.create(newSchedule({ name: "A" }), T0);
    const b = store.create(newSchedule({ name: "B", enabled: false }), T1);
    expect(store.list().map((s) => [s.name, s.enabled])).toEqual([["A", true], ["B", false]]);
    expect(store.list().map((s) => s.id)).toEqual([a.id, b.id]);
  });

  it("changes only the given fields and moves updatedAt", () => {
    const s = store.create(newSchedule(), T0);
    const updated = store.update(s.id, {
      timing: { kind: "cron", expression: "0 10 * * 1-5" },
      timeZone: "Australia/Lord_Howe",
      activeSince: T1,
      enabled: false,
    }, T1);
    expect(updated).toEqual({
      ...s,
      enabled: false,
      timing: { kind: "cron", expression: "0 10 * * 1-5" },
      timeZone: "Australia/Lord_Howe",
      activeSince: T1,
      updatedAt: T1,
    });

    expect(store.update(s.id, { name: "Renamed", spec: { prompt: "other" } }, T1)).toMatchObject({
      name: "Renamed",
      spec: { prompt: "other" },
      timeZone: "Australia/Lord_Howe",
    });
  });

  it("records a start's reason without moving updatedAt, and clears it", () => {
    const s = store.create(newSchedule(), T0);
    store.setNeedsUserReason(s.id, "The repository is no longer trusted.");
    expect(store.get(s.id)).toMatchObject({ needsUserReason: "The repository is no longer trusted.", updatedAt: T0 });
    store.setNeedsUserReason(s.id, null);
    expect(store.get(s.id)).not.toHaveProperty("needsUserReason");
  });

  it("deletes a schedule with its run history, and keeps the run sessions' links (req 32)", () => {
    const sessions = new SessionManager(dbManager);
    const s = store.create(newSchedule(), T0);
    const other = store.create(newSchedule({ name: "Other" }), T0);
    const run = store.insertRun({ scheduleId: s.id, slotAt: new Date(T1) })!;
    store.insertRun({ scheduleId: other.id, slotAt: new Date(T1) });
    sessions.track("run-session");
    sessions.setScheduleRun("run-session", s.id, run.id);

    expect(store.delete(s.id)).toBe(true);
    expect(store.get(s.id)).toBeNull();
    expect(store.getRun(run.id)).toBeNull();
    expect(store.listRuns(other.id)).toHaveLength(1);
    expect(sessions.get("run-session")).toMatchObject({ scheduleId: s.id, scheduleRunId: run.id });
  });

  it("is emptied by a full reset", () => {
    const s = store.create(newSchedule(), T0);
    store.insertRun({ scheduleId: s.id, slotAt: new Date(T1) });
    dbManager.clearAll();
    expect(store.list()).toEqual([]);
    expect(dbManager.db.prepare("SELECT COUNT(*) AS n FROM schedule_runs").get()).toEqual({ n: 0 });
  });
});

describe("ScheduleStore — runs", () => {
  it("claims a slot once: a second claim of the same slot gets null", () => {
    const s = store.create(newSchedule(), T0);
    const claim = store.insertRun({ scheduleId: s.id, slotAt: new Date(T1), spec: SPEC }, T1);
    expect(claim).toEqual({
      id: expect.any(String),
      scheduleId: s.id,
      slotAt: T1,
      spec: SPEC,
      outcome: "starting",
      createdAt: T1,
    });
    expect(store.insertRun({ scheduleId: s.id, slotAt: new Date(T1) })).toBeNull();
    expect(store.listRuns(s.id)).toHaveLength(1);
  });

  it("lets Run now rows, other slots and other schedules' same slot through", () => {
    const s = store.create(newSchedule(), T0);
    const other = store.create(newSchedule({ name: "Other" }), T0);
    expect(store.insertRun({ scheduleId: s.id, slotAt: null })).not.toBeNull();
    expect(store.insertRun({ scheduleId: s.id, slotAt: null })).not.toBeNull();
    expect(store.insertRun({ scheduleId: s.id, slotAt: new Date(T1) })).not.toBeNull();
    expect(store.insertRun({ scheduleId: s.id, slotAt: new Date(T0) })).not.toBeNull();
    expect(store.insertRun({ scheduleId: other.id, slotAt: new Date(T1) })).not.toBeNull();
    expect(store.listRuns(s.id)).toHaveLength(4);
  });

  it("refuses a run of a schedule that does not exist", () => {
    expect(() => store.insertRun({ scheduleId: "missing", slotAt: null })).toThrow(/FOREIGN KEY/);
  });

  it("records a skipped row with its reason", () => {
    const s = store.create(newSchedule(), T0);
    expect(store.insertRun({ scheduleId: s.id, slotAt: null, outcome: "skipped", reason: "3 runs missed" }))
      .toMatchObject({ outcome: "skipped", reason: "3 runs missed", slotAt: null });
  });

  it("updates a run's outcome, reason, session, result and start time", () => {
    const s = store.create(newSchedule(), T0);
    const run = store.insertRun({ scheduleId: s.id, slotAt: new Date(T1) }, T1)!;
    expect(store.updateRun(run.id, { outcome: "failed", reason: "No quota left." })).toMatchObject({
      outcome: "failed",
      reason: "No quota left.",
    });
    expect(store.updateRun(run.id, {
      outcome: "started",
      reason: null,
      sessionId: "sess-1",
      result: "Merged two security PRs.",
      startedAt: "2026-10-07T09:00:05.000Z",
    })).toEqual({
      id: run.id,
      scheduleId: s.id,
      slotAt: T1,
      outcome: "started",
      sessionId: "sess-1",
      result: "Merged two security PRs.",
      startedAt: "2026-10-07T09:00:05.000Z",
      createdAt: T1,
    });
    expect(store.updateRun("missing", { outcome: "failed" })).toBeNull();
  });

  it("lists a schedule's runs newest first, with an optional limit (req 24)", () => {
    const s = store.create(newSchedule(), T0);
    const first = store.insertRun({ scheduleId: s.id, slotAt: new Date(T0) }, T0)!;
    const runNow = store.insertRun({ scheduleId: s.id, slotAt: null }, T1)!;
    const sameMs = store.insertRun({ scheduleId: s.id, slotAt: new Date(T1) }, T1)!;
    expect(store.listRuns(s.id).map((r) => r.id)).toEqual([sameMs.id, runNow.id, first.id]);
    expect(store.listRuns(s.id, 2).map((r) => r.id)).toEqual([sameMs.id, runNow.id]);
  });

  it("gives the latest claimed slot, ignoring Run now rows", () => {
    const s = store.create(newSchedule(), T0);
    expect(store.latestSlotAt(s.id)).toBeNull();
    store.insertRun({ scheduleId: s.id, slotAt: null });
    expect(store.latestSlotAt(s.id)).toBeNull();
    store.insertRun({ scheduleId: s.id, slotAt: new Date(T1) });
    store.insertRun({ scheduleId: s.id, slotAt: new Date(T0) });
    store.insertRun({ scheduleId: s.id, slotAt: null });
    expect(store.latestSlotAt(s.id)).toBe(T1);
  });
});
