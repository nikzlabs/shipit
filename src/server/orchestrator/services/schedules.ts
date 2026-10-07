import type { ScheduleChanges, ScheduleStore } from "../schedule-store.js";
import type { RepoStore } from "../repo-store.js";
import type { CredentialStore } from "../credential-store.js";
import type {
  Schedule,
  ScheduleRun,
  ScheduleTiming,
  ScheduleView,
  SessionStartSpec,
  UnfinishedScheduleRun,
} from "../../shared/types.js";
import { RESERVED_ROLE_NAME } from "../../shared/types/agent-types.js";
import { KNOWN_AGENT_IDS } from "../../shared/agent-registry.js";
import { catalogueModelLabels, selectionExists } from "../../shared/catalogue/index.js";
import { nextRuns, normalizeTimeZone, parseScheduleTiming, timingProblem } from "../../shared/schedule-timing.js";
import { parseSessionStartSpec } from "../../shared/session-start-spec.js";
import { resolveUserRole } from "./session-role.js";
import { ServiceError } from "./types.js";

/**
 * docs/324-scheduled-sessions — reading and changing schedules (reqs 10, 17, 19, 26). Every
 * change goes through the schedule's queue, so it never interleaves with a run's start.
 */

const NEXT_RUNS_SHOWN = 3;
const MAX_NAME_CHARS = 120;
export const MAX_RUN_HISTORY = 1000;

export interface ScheduleSpecDeps {
  repoStore: Pick<RepoStore, "get" | "isTrusted">;
  credentialStore: CredentialStore;
}

/** The scheduler's side of a change: its queue, Run now, Stop, its runs, and telling the browser. */
export interface ScheduleQueue {
  enqueue<T>(scheduleId: string, fn: () => T | Promise<T>): Promise<T>;
  runNow(scheduleId: string): Promise<ScheduleRun>;
  stopRun(scheduleId: string, runId: string): Promise<ScheduleRun | null>;
  unfinishedRuns(scheduleId: string): Promise<UnfinishedScheduleRun[]>;
  announceSchedules(): void;
}

/** Req 32 — the refusal names the runs, so the user can stop each one. */
export class ScheduleDeleteRefused extends ServiceError {
  constructor(public readonly runs: UnfinishedScheduleRun[]) {
    const stopping = runs.filter((run) => run.stopping).length;
    const toStop = runs.length - stopping;
    const parts = [
      ...(toStop > 0 ? [`stop ${toStop === 1 ? "the run that is" : `the ${toStop} runs that are`} not finished`] : []),
      ...(stopping > 0 ? [`wait for ${stopping === 1 ? "the stopped run" : `the ${stopping} stopped runs`} to wind down`] : []),
    ];
    super(409, `This schedule still has runs in progress. To delete it, ${parts.join(", and ")}.`);
  }
}

export interface ScheduleServiceDeps extends ScheduleSpecDeps {
  store: ScheduleStore;
  scheduler: ScheduleQueue;
}

/**
 * Why a run cannot start from this description, or null. `save` checks what the
 * description names; `run` adds what can stop being true after it was saved (req 18).
 */
export function scheduleSpecProblem(
  spec: SessionStartSpec,
  deps: ScheduleSpecDeps,
  purpose: "save" | "run",
): string | null {
  const { target, params } = spec;
  if (target.kind === "repo") {
    if (!deps.repoStore.get(target.repoUrl)) return `The repository ${target.repoUrl} is not added to ShipIt.`;
    if (purpose === "run" && !deps.repoStore.isTrusted(target.repoUrl)) {
      return `The repository ${target.repoUrl} is not trusted. Trust it in ShipIt so its runs can start.`;
    }
  }
  if (params.role !== undefined) {
    if (purpose === "run") {
      try {
        resolveUserRole(params.role, { credentialStore: deps.credentialStore });
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    } else {
      const role = deps.credentialStore.getRole(params.role);
      if (!role || role.name === RESERVED_ROLE_NAME) return `There is no role named "${params.role}".`;
    }
  } else {
    // A role replaces the harness and model, so these are read only without one.
    if (params.agent !== undefined && !KNOWN_AGENT_IDS.includes(params.agent)) {
      return `Unknown harness "${params.agent}". Harnesses: ${KNOWN_AGENT_IDS.join(", ")}.`;
    }
    if (params.model !== undefined) {
      const offered = params.serviceId !== undefined && params.billingMode !== undefined
        ? selectionExists({ serviceId: params.serviceId, billingMode: params.billingMode, modelId: params.model })
        : params.model in catalogueModelLabels();
      if (!offered) return `ShipIt does not offer the model ${params.model}.`;
    }
  }
  if (params.sshHosts?.length) {
    const known = new Set(deps.credentialStore.listSshHosts().map((host) => host.id));
    const missing = params.sshHosts.filter((id) => !known.has(id));
    if (missing.length > 0) return `The SSH destination ${missing.join(", ")} does not exist.`;
  }
  return null;
}

export function toScheduleView(schedule: Schedule, now = new Date()): ScheduleView {
  const parsed = parseSessionStartSpec(schedule.spec);
  let upcoming: string[] = [];
  if (schedule.enabled) {
    try {
      upcoming = nextRuns(schedule.timing, schedule.timeZone, NEXT_RUNS_SHOWN, now).map((d) => d.toISOString());
    } catch {
      // A timing that no longer compiles shows no times; the scheduler reports it.
    }
  }
  return { ...schedule, spec: "spec" in parsed ? parsed.spec : null, nextRuns: upcoming };
}

function body(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ServiceError(400, "The request body must be an object.");
  }
  return input as Record<string, unknown>;
}

function readName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) throw new ServiceError(400, "The schedule needs a name.");
  if (name.length > MAX_NAME_CHARS || /[\r\n]/.test(name)) {
    throw new ServiceError(400, `The name must be one line of at most ${MAX_NAME_CHARS} characters.`);
  }
  return name;
}

function readTimeZone(value: unknown): string {
  const zone = typeof value === "string" ? normalizeTimeZone(value.trim()) : null;
  if (!zone) throw new ServiceError(400, `Unknown time zone ${JSON.stringify(value)}. Use an IANA name such as Europe/Berlin.`);
  return zone;
}

function readTiming(value: unknown): ScheduleTiming {
  const timing = parseScheduleTiming(value);
  if (!timing) {
    throw new ServiceError(
      400,
      'The timing must be a preset ({ kind: "hourly" | "daily" | "weekdays" | "weekly", … }) '
        + 'or a cron expression ({ kind: "cron", expression }).',
    );
  }
  return timing;
}

function checkTiming(timing: ScheduleTiming, timeZone: string): void {
  const problem = timingProblem(timing, timeZone);
  if (problem) throw new ServiceError(400, problem);
}

function readSpec(value: unknown, deps: ScheduleSpecDeps): SessionStartSpec {
  const parsed = parseSessionStartSpec(value);
  if ("problem" in parsed) throw new ServiceError(400, parsed.problem);
  const problem = scheduleSpecProblem(parsed.spec, deps, "save");
  if (problem) throw new ServiceError(400, problem);
  return parsed.spec;
}

function existing(deps: ScheduleServiceDeps, id: string): Schedule {
  const schedule = deps.store.get(id);
  if (!schedule) throw new ServiceError(404, "Schedule not found");
  return schedule;
}

export function listSchedules(deps: Pick<ScheduleServiceDeps, "store">): ScheduleView[] {
  const now = new Date();
  return deps.store.list().map((schedule) => toScheduleView(schedule, now));
}

export function getSchedule(deps: ScheduleServiceDeps, id: string): ScheduleView {
  return toScheduleView(existing(deps, id));
}

/** Its first slot comes after now (`active_since`): a schedule never runs for a time before it existed. */
export function createSchedule(deps: ScheduleServiceDeps, input: unknown): ScheduleView {
  const fields = body(input);
  const name = readName(fields.name);
  const timeZone = readTimeZone(fields.timeZone);
  const timing = readTiming(fields.timing);
  checkTiming(timing, timeZone);
  const spec = readSpec(fields.spec, deps);
  if (fields.enabled !== undefined && typeof fields.enabled !== "boolean") {
    throw new ServiceError(400, "enabled must be true or false.");
  }
  const schedule = deps.store.create({ name, enabled: fields.enabled !== false, timing, timeZone, spec });
  deps.scheduler.announceSchedules();
  return toScheduleView(schedule);
}

const EDITABLE_FIELDS = new Set(["name", "timing", "timeZone", "spec"]);

/**
 * Req 19 — applies from the next run; a run holds its own copy of the spec. A changed
 * timing or zone moves `active_since`, so a slot of the old timing does not run. Any edit
 * clears the reason a start failed (req 18): the user has acted on it.
 */
export async function updateSchedule(deps: ScheduleServiceDeps, id: string, input: unknown): Promise<ScheduleView> {
  const fields = body(input);
  for (const key of Object.keys(fields)) {
    if (key === "enabled") throw new ServiceError(400, "Pause or resume the schedule to change whether it runs.");
    if (!EDITABLE_FIELDS.has(key)) throw new ServiceError(400, `Unknown schedule field "${key}".`);
  }
  return deps.scheduler.enqueue(id, () => {
    const current = existing(deps, id);
    const changes: ScheduleChanges = {};
    if (fields.name !== undefined) changes.name = readName(fields.name);
    if (fields.timeZone !== undefined) changes.timeZone = readTimeZone(fields.timeZone);
    if (fields.timing !== undefined) changes.timing = readTiming(fields.timing);
    const timing = changes.timing ?? current.timing;
    const timeZone = changes.timeZone ?? current.timeZone;
    if (JSON.stringify(timing) !== JSON.stringify(current.timing) || timeZone !== current.timeZone) {
      checkTiming(timing, timeZone);
      changes.activeSince = new Date().toISOString();
    }
    if (fields.spec !== undefined) changes.spec = readSpec(fields.spec, deps);
    deps.store.update(id, changes);
    deps.store.setNeedsUserReason(id, null);
    deps.scheduler.announceSchedules();
    return toScheduleView(existing(deps, id));
  });
}

export async function pauseSchedule(deps: ScheduleServiceDeps, id: string): Promise<ScheduleView> {
  return deps.scheduler.enqueue(id, () => {
    if (existing(deps, id).enabled) {
      deps.store.update(id, { enabled: false });
      deps.scheduler.announceSchedules();
    }
    return toScheduleView(existing(deps, id));
  });
}

/** Slots that passed while paused do not run, and the reason a start failed is cleared (req 18). */
export async function resumeSchedule(deps: ScheduleServiceDeps, id: string): Promise<ScheduleView> {
  return deps.scheduler.enqueue(id, () => {
    if (!existing(deps, id).enabled) {
      deps.store.update(id, { enabled: true, activeSince: new Date().toISOString() });
      deps.store.setNeedsUserReason(id, null);
      deps.scheduler.announceSchedules();
    }
    return toScheduleView(existing(deps, id));
  });
}

/** Req 26 — no overlap or spacing check, and a paused schedule runs too. */
export async function runScheduleNow(deps: ScheduleServiceDeps, id: string): Promise<ScheduleRun> {
  existing(deps, id);
  return deps.scheduler.runNow(id);
}

/** Req 24 — newest first. */
export function listScheduleRuns(deps: ScheduleServiceDeps, id: string, limit?: number): ScheduleRun[] {
  existing(deps, id);
  const capped = limit === undefined || !Number.isInteger(limit) || limit <= 0
    ? MAX_RUN_HISTORY
    : Math.min(limit, MAX_RUN_HISTORY);
  return deps.store.listRuns(id, capped);
}

/** Req 26 — what Run now warns about; archived runs count too. */
export async function listUnfinishedRuns(deps: ScheduleServiceDeps, id: string): Promise<UnfinishedScheduleRun[]> {
  existing(deps, id);
  return deps.scheduler.unfinishedRuns(id);
}

/** Req 33 — also for a run whose schedule was deleted, which its session still names. */
export async function stopScheduleRun(deps: ScheduleServiceDeps, id: string, runId: string): Promise<ScheduleRun | null> {
  return deps.scheduler.stopRun(id, runId);
}

/**
 * Req 32 — removes the schedule and its run history; the run sessions stay and keep the
 * schedule's id, so each can say its schedule was deleted. Refused while a run is not finished.
 */
export async function deleteSchedule(deps: ScheduleServiceDeps, id: string): Promise<void> {
  await deps.scheduler.enqueue(id, async () => {
    existing(deps, id);
    const runs = await deps.scheduler.unfinishedRuns(id);
    if (runs.length > 0) throw new ScheduleDeleteRefused(runs);
    deps.store.delete(id);
    deps.scheduler.announceSchedules();
  });
}
