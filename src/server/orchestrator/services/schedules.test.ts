import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseManager } from "../../shared/database.js";
import { ScheduleStore } from "../schedule-store.js";
import type { CredentialStore } from "../credential-store.js";
import type { ScheduleRun, UnfinishedScheduleRun } from "../../shared/types.js";
import {
  createSchedule,
  deleteSchedule,
  getSchedule,
  listScheduleRuns,
  listSchedules,
  pauseSchedule,
  resumeSchedule,
  runScheduleNow,
  ScheduleDeleteRefused,
  scheduleSpecProblem,
  updateSchedule,
  type ScheduleServiceDeps,
} from "./schedules.js";

const REPO = "https://github.com/o/r";
const SPEC = {
  target: { kind: "repo", repoUrl: REPO },
  params: { permissionMode: "auto" },
  prompt: "Check current security PRs and merge them.",
};
const DAILY = { kind: "daily", hour: 9, minute: 0 };

let db: DatabaseManager;
let store: ScheduleStore;
let deps: ScheduleServiceDeps;
let queued: string[];
let announced: number;
let trusted: boolean;
let roles: string[];
let unfinished: UnfinishedScheduleRun[];

function input(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: "Security PRs", timing: DAILY, timeZone: "Europe/Berlin", spec: SPEC, ...over };
}

beforeEach(() => {
  db = new DatabaseManager(":memory:");
  store = new ScheduleStore(db);
  queued = [];
  announced = 0;
  trusted = true;
  roles = ["reviewer"];
  unfinished = [];
  deps = {
    store,
    repoStore: { get: (url: string) => (url === REPO ? ({ url } as never) : undefined), isTrusted: () => trusted },
    credentialStore: {
      getRole: (name: string) => (roles.includes(name) ? { name } : undefined),
      getRoles: () => roles.map((name) => ({ name })),
      listSshHosts: () => [{ id: "host-1" }],
    } as unknown as CredentialStore,
    scheduler: {
      enqueue: async <T>(id: string, fn: () => T | Promise<T>): Promise<T> => {
        queued.push(id);
        return fn();
      },
      runNow: async (id: string) => ({ id: "run-1", scheduleId: id, slotAt: null, outcome: "starting" }) as ScheduleRun,
      stopRun: async () => null,
      unfinishedRuns: async () => unfinished,
      announceSchedules: () => { announced += 1; },
      viewRuns: (runs) => runs,
    },
  };
});

afterEach(() => {
  db.close();
});

describe("createSchedule", () => {
  it("stores a schedule that is active from now and tells the browser", () => {
    const before = Date.now();
    const view = createSchedule(deps, input({ timeZone: "europe/berlin" }));
    expect(view).toMatchObject({
      name: "Security PRs",
      enabled: true,
      timing: DAILY,
      timeZone: "Europe/Berlin",
      spec: { target: SPEC.target, params: { permissionMode: "auto" }, prompt: SPEC.prompt },
    });
    expect(Date.parse(view.activeSince)).toBeGreaterThanOrEqual(before);
    expect(view.nextRuns).toHaveLength(3);
    expect(announced).toBe(1);
    expect(listSchedules(deps).map((s) => s.id)).toEqual([view.id]);
  });

  it("refuses what cannot be saved, by name", () => {
    expect(() => createSchedule(deps, input({ name: "  " }))).toThrow("The schedule needs a name.");
    expect(() => createSchedule(deps, input({ timeZone: "Mars/Olympus" }))).toThrow(/Unknown time zone/);
    expect(() => createSchedule(deps, input({ timing: { kind: "sometimes" } }))).toThrow(/The timing must be/);
    expect(() => createSchedule(deps, input({ timing: { kind: "cron", expression: "*/30 * * * *" } })))
      .toThrow(/at least an hour apart/);
    expect(() => createSchedule(deps, input({ spec: { ...SPEC, params: { colour: "red" } } })))
      .toThrow('Unknown session-start parameter "colour".');
    expect(() => createSchedule(deps, input({ spec: { ...SPEC, target: { kind: "repo", repoUrl: "https://x/y" } } })))
      .toThrow("The repository https://x/y is not added to ShipIt.");
    expect(() => createSchedule(deps, input({ spec: { ...SPEC, params: { role: "nobody" } } })))
      .toThrow('There is no role named "nobody".');
    expect(() => createSchedule(deps, input({ spec: { ...SPEC, params: { model: "gpt-0" } } })))
      .toThrow("ShipIt does not offer the model gpt-0.");
    expect(() => createSchedule(deps, input({ spec: { ...SPEC, params: { sshHosts: ["host-9"] } } })))
      .toThrow("The SSH destination host-9 does not exist.");
    expect(() => createSchedule(deps, input({ enabled: "yes" }))).toThrow("enabled must be true or false.");
    expect(listSchedules(deps)).toEqual([]);
  });

  it("saves a schedule whose repository is not trusted yet; its runs check that (req 18)", () => {
    trusted = false;
    const view = createSchedule(deps, input());
    expect(scheduleSpecProblem(view.spec!, deps, "run")).toMatch(/is not trusted/);
  });
});

describe("updateSchedule", () => {
  it("changes only the given fields, through the schedule's queue, and clears the reason a start failed", async () => {
    const created = createSchedule(deps, input());
    store.setNeedsUserReason(created.id, "The repository is not trusted.");
    const view = await updateSchedule(deps, created.id, { name: "Nightly security PRs" });
    expect(queued).toEqual([created.id]);
    expect(view).toMatchObject({ name: "Nightly security PRs", timing: DAILY, activeSince: created.activeSince });
    expect(view.needsUserReason).toBeUndefined();
  });

  it("moves active_since when the timing or the zone changes, and not when it is sent unchanged", async () => {
    const created = store.create({ ...input(), timing: DAILY, spec: SPEC } as never, "2026-01-01T00:00:00.000Z");
    const same = await updateSchedule(deps, created.id, { timing: DAILY, timeZone: "Europe/Berlin" });
    expect(same.activeSince).toBe("2026-01-01T00:00:00.000Z");
    const moved = await updateSchedule(deps, created.id, { timing: { kind: "weekdays", hour: 9, minute: 0 } });
    expect(moved.activeSince).not.toBe("2026-01-01T00:00:00.000Z");
    const zoned = await updateSchedule(deps, created.id, { timeZone: "UTC" });
    expect(Date.parse(zoned.activeSince)).toBeGreaterThanOrEqual(Date.parse(moved.activeSince));
  });

  it("refuses a pause by edit, unknown fields, a missing schedule and a too-close timing", async () => {
    const created = createSchedule(deps, input());
    await expect(updateSchedule(deps, created.id, { enabled: false })).rejects.toThrow(/Pause or resume/);
    await expect(updateSchedule(deps, created.id, { colour: "red" })).rejects.toThrow('Unknown schedule field "colour".');
    await expect(updateSchedule(deps, "missing", { name: "x" })).rejects.toThrow("Schedule not found");
    await expect(updateSchedule(deps, created.id, { timing: { kind: "cron", expression: "0,30 9 * * *" } }))
      .rejects.toThrow(/at least an hour apart/);
    expect(getSchedule(deps, created.id).timing).toEqual(DAILY);
  });
});

describe("pause and resume (req 19)", () => {
  it("pauses; resume makes slots of the paused stretch not run and clears the reason a start failed", async () => {
    const created = store.create({ ...input(), timing: DAILY, spec: SPEC } as never, "2026-01-01T00:00:00.000Z");
    store.setNeedsUserReason(created.id, "Out of quota.");
    const paused = await pauseSchedule(deps, created.id);
    expect(paused).toMatchObject({ enabled: false, nextRuns: [], needsUserReason: "Out of quota." });

    const resumed = await resumeSchedule(deps, created.id);
    expect(resumed.enabled).toBe(true);
    expect(resumed.activeSince).not.toBe("2026-01-01T00:00:00.000Z");
    expect(resumed.needsUserReason).toBeUndefined();
    expect(queued).toEqual([created.id, created.id]);

    const again = await resumeSchedule(deps, created.id);
    expect(again.activeSince).toBe(resumed.activeSince);
  });
});

describe("Run now and the run history", () => {
  it("hands Run now to the scheduler, and refuses a missing schedule", async () => {
    const created = createSchedule(deps, input());
    expect(await runScheduleNow(deps, created.id)).toMatchObject({ scheduleId: created.id, slotAt: null });
    await expect(runScheduleNow(deps, "missing")).rejects.toThrow("Schedule not found");
  });

  it("lists runs newest first, with a capped limit", () => {
    const created = createSchedule(deps, input());
    for (let i = 0; i < 3; i++) store.insertRun({ scheduleId: created.id, slotAt: null }, `2026-10-0${i + 1}T00:00:00.000Z`);
    expect(listScheduleRuns(deps, created.id)).toHaveLength(3);
    expect(listScheduleRuns(deps, created.id, 2).map((r) => r.createdAt)).toEqual([
      "2026-10-03T00:00:00.000Z",
      "2026-10-02T00:00:00.000Z",
    ]);
    expect(() => listScheduleRuns(deps, "missing")).toThrow("Schedule not found");
  });

  it("returns the scheduler's view of the runs", () => {
    const created = createSchedule(deps, input());
    store.insertRun({ scheduleId: created.id, slotAt: null, outcome: "started" });
    deps.scheduler.viewRuns = (runs) => runs.map((run) => ({ ...run, sessionDeleted: true }));
    expect(listScheduleRuns(deps, created.id)).toEqual([expect.objectContaining({ sessionDeleted: true })]);
  });
});

describe("Delete (req 32)", () => {
  it("is refused through the queue while a run is not finished, and names the runs", async () => {
    const created = createSchedule(deps, input());
    unfinished = [
      { runId: "run-1", sessionId: "s-1", title: "Security PRs · Oct 7, 09:00", archived: true },
      { runId: "run-2", sessionId: "s-2", title: "Security PRs · Oct 8, 09:00", stopping: true },
    ];
    const refusal = await deleteSchedule(deps, created.id).catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(ScheduleDeleteRefused);
    expect(refusal).toMatchObject({
      statusCode: 409,
      runs: unfinished,
      message: "This schedule still has runs in progress. To delete it, stop the run that is not finished, "
        + "and wait for the stopped run to wind down.",
    });
    expect(queued).toEqual([created.id]);
    expect(getSchedule(deps, created.id).id).toBe(created.id);
  });

  it("removes the schedule and its run history once every run is finished", async () => {
    const created = createSchedule(deps, input());
    store.insertRun({ scheduleId: created.id, slotAt: null, outcome: "started" });
    announced = 0;
    await deleteSchedule(deps, created.id);
    expect(store.get(created.id)).toBeNull();
    expect(store.listRuns(created.id)).toEqual([]);
    expect(announced).toBe(1);
    await expect(deleteSchedule(deps, created.id)).rejects.toThrow("Schedule not found");
  });
});
