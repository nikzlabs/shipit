import { Cron } from "croner";
import type { Schedule, ScheduleTiming } from "./types.js";

/**
 * docs/324-scheduled-sessions — when a schedule's runs come due (reqs 16, 17, 29).
 *
 * Every run time comes from `runsAfter`, never from croner's `previousRuns` or
 * `nextRuns`: on a spring change day the first returns a time still to come and the
 * second lists one time twice. The tests pin req 29's daylight-saving behaviour.
 */

export const MIN_RUN_SPACING_MS = 60 * 60 * 1000;

/** Req 17 is checked over this many upcoming run times. */
export const SPACING_CHECK_RUNS = 100;

export function timingToCron(timing: ScheduleTiming): string {
  switch (timing.kind) {
    case "hourly":
      return `${timing.minute} * * * *`;
    case "daily":
      return `${timing.minute} ${timing.hour} * * *`;
    case "weekdays":
      return `${timing.minute} ${timing.hour} * * 1-5`;
    case "weekly":
      return `${timing.minute} ${timing.hour} * * ${timing.weekday}`;
    case "cron":
      return timing.expression.trim();
  }
}

/** The zone's IANA name with its canonical case, or null. A fixed UTC offset is not a zone. */
export function normalizeTimeZone(timeZone: string): string | null {
  if (/^[+-]/.test(timeZone)) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** The shape of a stored or proposed timing; `timingProblem` checks its values. */
export function parseScheduleTiming(value: unknown): ScheduleTiming | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const num = (key: string) => typeof v[key] === "number";
  switch (v.kind) {
    case "hourly":
      return num("minute") ? { kind: "hourly", minute: v.minute as number } : null;
    case "daily":
    case "weekdays":
      return num("hour") && num("minute")
        ? { kind: v.kind, hour: v.hour as number, minute: v.minute as number }
        : null;
    case "weekly":
      return num("weekday") && num("hour") && num("minute")
        ? { kind: "weekly", weekday: v.weekday as number, hour: v.hour as number, minute: v.minute as number }
        : null;
    case "cron":
      return typeof v.expression === "string" ? { kind: "cron", expression: v.expression } : null;
    default:
      return null;
  }
}

function presetProblem(timing: ScheduleTiming): string | null {
  const whole = (n: number, max: number) => Number.isInteger(n) && n >= 0 && n <= max;
  if (timing.kind === "cron") return timing.expression.trim() ? null : "The cron expression is empty.";
  if (!whole(timing.minute, 59)) return "The minute must be a whole number from 0 to 59.";
  if (timing.kind !== "hourly" && !whole(timing.hour, 23)) return "The hour must be a whole number from 0 to 23.";
  if (timing.kind === "weekly" && !whole(timing.weekday, 6)) {
    return "The weekday must be a whole number from 0 (Sunday) to 6 (Saturday).";
  }
  return null;
}

/** Throws on what croner cannot parse; an unknown zone throws at the first `nextRun`. */
function compile(timing: ScheduleTiming, timeZone: string): Cron {
  const cron = new Cron(timingToCron(timing), { timezone: timeZone, mode: "5-part" });
  // Croner takes a date string as a one-time job rather than refusing it.
  if (cron.getOnce() !== null) throw new Error("a date is not a cron expression");
  return cron;
}

/** Longer than any daylight-saving change. */
const WALK_LOOKBACK_MS = 3 * 60 * 60 * 1000;

/**
 * The run times strictly after `from`, in order. Croner steps in wall-clock time: from
 * inside a repeated hour it can answer with an earlier instant, and from just after a
 * spring gap it misses the run the gap moved past `from`. So the walk starts earlier
 * and keeps only later instants.
 */
function* runsAfter(cron: Cron, from: Date): Generator<Date> {
  let last = from;
  for (let next = cron.nextRun(new Date(from.getTime() - WALK_LOOKBACK_MS)); next; next = cron.nextRun(next)) {
    if (next <= last) continue;
    last = next;
    yield next;
  }
}

function stepRuns(cron: Cron, n: number, from: Date): Date[] {
  const runs: Date[] = [];
  if (n <= 0) return runs;
  for (const run of runsAfter(cron, from)) {
    runs.push(run);
    if (runs.length >= n) break;
  }
  return runs;
}

/** A date and time as the schedule's zone shows it, e.g. "2026-10-07 09:00". */
export function formatInZone(date: Date, timeZone: string): string {
  return date.toLocaleString("sv-SE", { timeZone, dateStyle: "short", timeStyle: "short" });
}

/** Why a timing cannot be saved or proposed, or null when it can. */
export function timingProblem(timing: ScheduleTiming, timeZone: string, now = new Date()): string | null {
  if (!normalizeTimeZone(timeZone)) {
    return `Unknown time zone "${timeZone}". Use an IANA name such as Europe/Berlin.`;
  }
  const preset = presetProblem(timing);
  if (preset) return preset;
  let cron: Cron;
  try {
    compile(timing, timeZone);
    // Req 17 counts the times as the schedule gives them, so clock changes are left out:
    // UTC has none, and a timing is then accepted or refused the same on every date.
    cron = compile(timing, "UTC");
  } catch (err) {
    return `"${timingToCron(timing)}" is not a cron expression: ${err instanceof Error ? err.message : String(err)}`;
  }
  const runs = stepRuns(cron, SPACING_CHECK_RUNS, now);
  if (runs.length === 0) return `"${timingToCron(timing)}" never runs.`;
  // Req 17 spaces the scheduled times; when a catch-up or Run now actually starts is not checked.
  for (let i = 1; i < runs.length; i++) {
    const gapMs = runs[i].getTime() - runs[i - 1].getTime();
    if (gapMs < MIN_RUN_SPACING_MS) {
      const time = (d: Date) => d.toLocaleTimeString("sv-SE", { timeZone: "UTC", timeStyle: "short" });
      return `Runs must be at least an hour apart, but two come ${Math.round(gapMs / 60_000)} minutes apart, `
        + `at ${time(runs[i - 1])} and ${time(runs[i])}.`;
    }
  }
  return null;
}

/** The next run times after `from`, for the cards and the editor. */
export function nextRuns(timing: ScheduleTiming, timeZone: string, n: number, from = new Date()): Date[] {
  return stepRuns(compile(timing, timeZone), n, from);
}

export interface DueSlots {
  /** The slot to run: the latest at or before now. */
  latest: Date;
  /** Req 15 — the earlier due slots, which do not run. */
  missed?: { count: number; first: Date; last: Date };
}

/**
 * The slots due after the later of `activeSince` and the latest claimed slot, up to
 * and including `now`; null when none is due. Only a summary is kept, so a long
 * downtime costs time but no memory.
 */
export function dueSlots(
  schedule: Pick<Schedule, "timing" | "timeZone" | "activeSince">,
  latestSlotAt: string | null,
  now = new Date(),
): DueSlots | null {
  const cron = compile(schedule.timing, schedule.timeZone);
  const activeSince = new Date(schedule.activeSince);
  const lastSlot = latestSlotAt === null ? null : new Date(latestSlotAt);
  const from = lastSlot && lastSlot > activeSince ? lastSlot : activeSince;
  let first: Date | undefined;
  let previous: Date | undefined;
  let latest: Date | undefined;
  let count = 0;
  for (const slot of runsAfter(cron, from)) {
    if (slot > now) break;
    count++;
    first ??= slot;
    previous = latest;
    latest = slot;
  }
  if (!latest) return null;
  return count > 1 && first && previous ? { latest, missed: { count: count - 1, first, last: previous } } : { latest };
}
