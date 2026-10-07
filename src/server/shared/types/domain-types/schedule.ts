import type { SessionStartSpec } from "./session-start.js";

/**
 * docs/324-scheduled-sessions — when a schedule's runs come due (req 16). A
 * preset compiles to a cron expression (`schedule-timing.ts`); hours and
 * minutes are wall-clock times in the schedule's time zone, and `weekday`
 * counts from Sunday = 0, as cron does.
 */
export type ScheduleTiming =
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekdays"; hour: number; minute: number }
  | { kind: "weekly"; weekday: number; hour: number; minute: number }
  | { kind: "cron"; expression: string };

export interface Schedule {
  id: string;
  name: string;
  enabled: boolean;
  timing: ScheduleTiming;
  /** An IANA zone name. */
  timeZone: string;
  /** A `SessionStartSpec` as stored JSON; kept opaque until the scheduler narrows it. */
  spec: unknown;
  /** No slot at or before this time runs: slots that passed while paused or under an older timing. */
  activeSince: string;
  /** Req 18 — why the last start failed, shown until the user acts on it. */
  needsUserReason?: string;
  createdAt: string;
  updatedAt: string;
}

/** A schedule as the browser reads it. */
export interface ScheduleView extends Omit<Schedule, "spec"> {
  /** Null when the stored description no longer reads. */
  spec: SessionStartSpec | null;
  /** The next run times as ISO strings; none while the schedule is paused. */
  nextRuns: string[];
}

export type ScheduleRunOutcome = "starting" | "started" | "skipped" | "failed";

/** One entry of a schedule's run history (req 24), and the claim of its slot. */
export interface ScheduleRun {
  id: string;
  scheduleId: string;
  /** The slot this run claimed; null for Run now. */
  slotAt: string | null;
  /** The copy of the schedule's spec this run starts with (req 19). */
  spec?: unknown;
  outcome: ScheduleRunOutcome;
  reason?: string;
  sessionId?: string;
  /** The one-line result, copied when the run finishes so it outlives the session. */
  result?: string;
  startedAt?: string;
  createdAt: string;
}

/** How a session's last turn ended, persisted because a run's "finished" needs it (req 31). */
export type LastTurnOutcome = "ok" | "errored" | "quota-refused";
