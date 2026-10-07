import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  deleteSchedule,
  openScheduleSettings,
  ScheduleRequestError,
  useScheduleStore,
} from "./schedule-store.js";
import { useUiStore } from "./ui-store.js";
import type { ScheduleRun, ScheduleRunView, ScheduleView } from "../../server/shared/types.js";

/** docs/324-scheduled-sessions — the browser's copy of the schedules and their runs. */

function schedule(id: string, over: Partial<ScheduleView> = {}): ScheduleView {
  return {
    id,
    name: `Schedule ${id}`,
    enabled: true,
    timing: { kind: "daily", hour: 9, minute: 0 },
    timeZone: "UTC",
    spec: null,
    activeSince: "2026-10-01T00:00:00.000Z",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    nextRuns: [],
    ...over,
  };
}

function run(id: string, scheduleId: string, over: Partial<ScheduleRunView> = {}): ScheduleRunView {
  return { id, scheduleId, slotAt: null, outcome: "started", createdAt: "2026-10-07T09:00:00.000Z", ...over };
}

function respond(body: unknown, status = 200) {
  return vi.fn(async () => ({ ok: status < 400, status, json: async () => body }));
}

beforeEach(() => {
  useScheduleStore.getState().reset();
  vi.unstubAllGlobals();
});

describe("schedule store", () => {
  it("reads the schedules and a schedule's runs", async () => {
    vi.stubGlobal("fetch", respond({ schedules: [schedule("a")] }));
    await useScheduleStore.getState().load();
    expect(useScheduleStore.getState()).toMatchObject({ loaded: true, schedules: [{ id: "a" }] });

    const fetchMock = respond({ runs: [run("r1", "a")] });
    vi.stubGlobal("fetch", fetchMock);
    await useScheduleStore.getState().loadRuns("a");
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("/api/schedules/a/runs?limit=50");
    expect(useScheduleStore.getState().runsBySchedule.a).toEqual([run("r1", "a")]);
  });

  it("applies a run event: a new run goes first, a changed one keeps what the history said of its session", () => {
    const session = { id: "s1", title: "t", createdAt: "", lastUsedAt: "", remoteUrl: "" };
    useScheduleStore.setState({ runsBySchedule: { a: [run("r1", "a", { session, result: undefined })] } });

    const finished: ScheduleRun = { ...run("r1", "a"), result: "Merged 2 PRs." };
    useScheduleStore.getState().applyRun(finished);
    useScheduleStore.getState().applyRun(run("r2", "a", { outcome: "starting" }));

    const runs = useScheduleStore.getState().runsBySchedule.a!;
    expect(runs.map((r) => r.id)).toEqual(["r2", "r1"]);
    expect(runs[1]).toMatchObject({ result: "Merged 2 PRs.", session });
  });

  it("drops a read of the schedules that a newer change overtook", async () => {
    let answer!: () => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise((resolve) => {
      answer = () => resolve({ ok: true, status: 200, json: async () => ({ schedules: [schedule("a"), schedule("b")] }) });
    })));
    const read = useScheduleStore.getState().load();
    // "b" was deleted after the read went out.
    useScheduleStore.getState().setSchedules([schedule("a")]);
    answer();
    await read;
    expect(useScheduleStore.getState().schedules.map((x) => x.id)).toEqual(["a"]);
  });

  it("applies the run events that came while a read of the runs was out on top of it", async () => {
    let answer!: () => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise((resolve) => {
      answer = () => resolve({ ok: true, status: 200, json: async () => ({ runs: [run("r1", "a", { outcome: "starting" })] }) });
    })));
    useScheduleStore.setState({ runsBySchedule: { a: [] } });
    const read = useScheduleStore.getState().loadRuns("a");
    useScheduleStore.getState().applyRun(run("r1", "a", { outcome: "started", sessionId: "s1" }));
    answer();
    await read;
    expect(useScheduleStore.getState().runsBySchedule.a).toEqual([
      expect.objectContaining({ id: "r1", outcome: "started", sessionId: "s1" }),
    ]);
  });

  it("ignores a run of a schedule whose runs were never read", () => {
    useScheduleStore.getState().applyRun(run("r1", "a"));
    expect(useScheduleStore.getState().runsBySchedule).toEqual({});
  });

  it("drops a deleted schedule's runs when the schedules change", () => {
    useScheduleStore.setState({ runsBySchedule: { a: [run("r1", "a")], b: [run("r2", "b")] } });
    useScheduleStore.getState().setSchedules([schedule("b")]);
    expect(Object.keys(useScheduleStore.getState().runsBySchedule)).toEqual(["b"]);
  });

  it("gives Delete's refusal the runs the server names (req 32)", async () => {
    const runs = [{ runId: "r1", sessionId: "s1", title: "Sweep · Oct 7, 09:00" }];
    vi.stubGlobal("fetch", respond({ error: "This schedule still has runs in progress.", runs }, 409));
    const refusal = await deleteSchedule("a").catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(ScheduleRequestError);
    expect(refusal).toMatchObject({ status: 409, runs, message: "This schedule still has runs in progress." });
  });

  it("opens Settings → Schedules at a schedule", () => {
    openScheduleSettings("a");
    expect(useUiStore.getState()).toMatchObject({ settingsOpen: true, settingsTab: "schedules", settingsScheduleId: "a" });
  });
});
