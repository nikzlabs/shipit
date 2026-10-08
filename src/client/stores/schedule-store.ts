import { create } from "zustand";
import { useUiStore } from "./ui-store.js";
import {
  MAX_RUNS_PER_READ,
  type ScheduleRun,
  type ScheduleRunView,
  type ScheduleView,
  type UnfinishedScheduleRun,
} from "../../server/shared/types.js";

/**
 * docs/324-scheduled-sessions — the browser's copy of the schedules and their runs. The
 * `schedules` and `schedule_run` browser events keep it current; Settings → Schedules, the
 * run banner and the "needs you" view all read it here.
 */

/** Runs read at a time; "Show older runs" reads one page more. */
export const RUNS_PAGE = 50;

interface ScheduleState {
  schedules: ScheduleView[];
  /** False until the first read answers, so a run cannot be taken for one of a deleted schedule before. */
  loaded: boolean;
  /** Each schedule's runs as last read, newest first; absent until read. */
  runsBySchedule: Record<string, ScheduleRunView[]>;
  /** How many runs of each schedule were asked for. */
  runLimits: Record<string, number>;

  load: () => Promise<void>;
  /** `limit` defaults to what was asked for last, or one page. */
  loadRuns: (scheduleId: string, limit?: number) => Promise<void>;
  /** Reads again every run list already read: a browser that was away missed `schedule_run`. */
  reloadRuns: () => Promise<void>;
  setSchedules: (schedules: ScheduleView[]) => void;
  upsertSchedule: (schedule: ScheduleView) => void;
  applyRun: (run: ScheduleRun) => void;
  reset: () => void;
}

/*
  A read can answer after an event that is newer than it. A schedules read is dropped when the
  list changed while it was out; a runs read is applied with the run events that came meanwhile
  applied again on top.
*/
let schedulesVersion = 0;
const runsInFlight = new Map<string, Set<ScheduleRun[]>>();

/** The newest `asked` runs, or all there are: one read returns at most `MAX_RUNS_PER_READ`. */
async function readRuns(scheduleId: string, asked: number): Promise<ScheduleRunView[]> {
  const runs: ScheduleRunView[] = [];
  for (;;) {
    const limit = Math.min(asked - runs.length, MAX_RUNS_PER_READ);
    const before = runs.at(-1)?.id;
    const page = await request<{ runs: ScheduleRunView[] }>(
      path(scheduleId, `/runs?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ""}`),
    );
    runs.push(...page.runs);
    if (page.runs.length < limit || runs.length >= asked) return runs;
  }
}

function withRun(runs: ScheduleRunView[], run: ScheduleRun): ScheduleRunView[] {
  const index = runs.findIndex((r) => r.id === run.id);
  if (index < 0) return [run, ...runs];
  // A row is `starting` only as it is made, so a `starting` copy that arrives late — Run now's
  // answer, sent after its pre-flight already failed the run — is older than the one held.
  if (run.outcome === "starting" && runs[index]?.outcome !== "starting") return runs;
  // The event carries the row alone; what the last read said of its session stays.
  return runs.map((r, i) => (i === index ? { ...r, ...run } : r));
}

export const useScheduleStore = create<ScheduleState>()((set, get) => ({
  schedules: [],
  loaded: false,
  runsBySchedule: {},
  runLimits: {},

  load: async () => {
    const version = schedulesVersion;
    try {
      const { schedules } = await request<{ schedules: ScheduleView[] }>("/api/schedules");
      if (version === schedulesVersion) set({ schedules, loaded: true });
    } catch (err) {
      console.error("[schedules] failed to read the schedules:", err);
    }
  },

  loadRuns: async (scheduleId, limit) => {
    const asked = limit ?? get().runLimits[scheduleId] ?? RUNS_PAGE;
    const arrived: ScheduleRun[] = [];
    const pending = runsInFlight.get(scheduleId) ?? new Set();
    runsInFlight.set(scheduleId, pending.add(arrived));
    try {
      const runs = await readRuns(scheduleId, asked);
      set((s) => ({
        runsBySchedule: { ...s.runsBySchedule, [scheduleId]: arrived.reduce(withRun, runs) },
        runLimits: { ...s.runLimits, [scheduleId]: asked },
      }));
    } catch (err) {
      console.error(`[schedules] failed to read the runs of schedule ${scheduleId}:`, err);
    } finally {
      pending.delete(arrived);
      if (pending.size === 0) runsInFlight.delete(scheduleId);
    }
  },

  reloadRuns: async () => {
    await Promise.all(Object.keys(get().runsBySchedule).map((id) => get().loadRuns(id)));
  },

  setSchedules: (schedules) => {
    schedulesVersion += 1;
    set((s) => {
      // A deleted schedule's run history went with it.
      const kept = new Set(schedules.map((schedule) => schedule.id));
      const runsBySchedule = Object.fromEntries(
        Object.entries(s.runsBySchedule).filter(([id]) => kept.has(id)),
      );
      return { schedules, loaded: true, runsBySchedule };
    });
  },

  upsertSchedule: (schedule) => {
    schedulesVersion += 1;
    set((s) => ({
      schedules: s.schedules.some((x) => x.id === schedule.id)
        ? s.schedules.map((x) => (x.id === schedule.id ? schedule : x))
        : [...s.schedules, schedule],
    }));
  },

  applyRun: (run) => {
    for (const arrived of runsInFlight.get(run.scheduleId) ?? []) arrived.push(run);
    set((s) => {
      const runs = s.runsBySchedule[run.scheduleId];
      if (!runs) return s;
      return { runsBySchedule: { ...s.runsBySchedule, [run.scheduleId]: withRun(runs, run) } };
    });
  },

  reset: () => {
    schedulesVersion += 1;
    set({ schedules: [], loaded: false, runsBySchedule: {}, runLimits: {} });
  },
}));

/**
 * Req 18, req 31 — a schedule whose last start failed needs the user until they act on it. The
 * one test for the "needs you" rows and count, and the Scheduled view's reasons and mark.
 */
export function scheduleNeedsYou(schedule: ScheduleView): boolean {
  return !!schedule.needsUserReason;
}

/**
 * Opens Settings → Schedules, at one schedule when given. The one way in: the run banner's
 * Open schedule, the Scheduled view's reasons and the schedule rows in "needs you".
 */
export function openScheduleSettings(scheduleId?: string): void {
  const ui = useUiStore.getState();
  ui.setSettingsScheduleId(scheduleId ?? null);
  ui.setSettingsTab("schedules");
  ui.setSettingsOpen(true);
}

/** A refused request, with the server's own words. */
export class ScheduleRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Delete's refusal names the runs that are not finished (req 32). */
    readonly runs?: UnfinishedScheduleRun[],
  ) {
    super(message);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; runs?: UnfinishedScheduleRun[] };
    throw new ScheduleRequestError(body.error ?? `HTTP ${res.status}`, res.status, body.runs);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const path = (scheduleId: string, rest = "") => `/api/schedules/${encodeURIComponent(scheduleId)}${rest}`;

export async function saveSchedule(scheduleId: string, changes: Record<string, unknown>): Promise<ScheduleView> {
  const { schedule } = await request<{ schedule: ScheduleView }>(path(scheduleId), {
    method: "PUT",
    body: JSON.stringify(changes),
  });
  useScheduleStore.getState().upsertSchedule(schedule);
  return schedule;
}

export async function setSchedulePaused(scheduleId: string, paused: boolean): Promise<void> {
  const { schedule } = await request<{ schedule: ScheduleView }>(path(scheduleId, paused ? "/pause" : "/resume"), {
    method: "POST",
  });
  useScheduleStore.getState().upsertSchedule(schedule);
}

/** Req 26 — what Run now warns about; also what holds back Delete (req 32). */
export async function fetchUnfinishedRuns(scheduleId: string): Promise<UnfinishedScheduleRun[]> {
  const { runs } = await request<{ runs: UnfinishedScheduleRun[] }>(path(scheduleId, "/unfinished-runs"));
  return runs;
}

export async function runScheduleNow(scheduleId: string): Promise<void> {
  const { run } = await request<{ run: ScheduleRun }>(path(scheduleId, "/run"), { method: "POST" });
  useScheduleStore.getState().applyRun(run);
}

/**
 * Req 33. The run's row may not change, but its session does — and an archived run's session
 * is in no list the browser follows — so its history is read again.
 */
export async function stopScheduleRun(scheduleId: string, runId: string): Promise<void> {
  const { run } = await request<{ run: ScheduleRun | null }>(
    path(scheduleId, `/runs/${encodeURIComponent(runId)}/stop`),
    { method: "POST" },
  );
  const store = useScheduleStore.getState();
  if (run) store.applyRun(run);
  if (store.runsBySchedule[scheduleId]) await store.loadRuns(scheduleId);
}

export async function deleteSchedule(scheduleId: string): Promise<void> {
  await request<undefined>(path(scheduleId), { method: "DELETE" });
  const store = useScheduleStore.getState();
  store.setSchedules(store.schedules.filter((schedule) => schedule.id !== scheduleId));
}
