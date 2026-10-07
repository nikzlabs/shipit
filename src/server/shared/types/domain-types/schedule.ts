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

/**
 * A run that is not finished (req 22), archived or not: it holds back Delete (req 32), and
 * Run now warns about it (req 26).
 */
export interface UnfinishedScheduleRun {
  runId: string;
  /** Absent while the run's session does not exist yet. */
  sessionId?: string;
  title: string;
  archived?: true;
  /** The user stopped it and its agent is still winding down, so Stop has nothing left to do. */
  stopping?: true;
}

/** How a session's last turn ended, persisted because a run's "finished" needs it (req 31). */
export type LastTurnOutcome = "ok" | "errored" | "quota-refused";

/**
 * docs/324-scheduled-sessions req 9 — a proposal card ends in exactly one of these. `stale`: the
 * schedule changed after the card was written; `refused`: ShipIt can no longer accept it.
 */
export type ScheduleProposalPhase = "pending" | "confirmed" | "stale" | "refused" | "cancelled";

/** One value on the card, in ShipIt's words; `before` only on a change. */
export interface ScheduleProposalValue {
  label: string;
  before?: string;
  after: string;
}

/**
 * The schedule proposal card (reqs 8, 9). The values are rendered on the server when the card is
 * written, so the card keeps saying what the user confirmed. What Confirm writes is in the private
 * proposal record (`schedule-proposal-store.ts`), never taken from the browser.
 */
export interface ScheduleProposalCard {
  cardId: string;
  kind: "create" | "update";
  /** The schedule a change is about, or the one Confirm created. */
  scheduleId?: string;
  /** The proposed name of a new schedule; the current name of a changed one. */
  name: string;
  /** Every value of a new schedule; only the values a change changes. */
  values: ScheduleProposalValue[];
  /** The prompt is many lines, so it is not a value; on a change, only when it changes. */
  prompt?: { before?: string; after: string };
  /** The timing after Confirm, for the next run times the browser shows. */
  timing: ScheduleTiming;
  /** The zone after Confirm; null when the proposal names none and Confirm sends the browser's. */
  timeZone: string | null;
  /** Whether the schedule runs after Confirm; a paused one shows no run times. */
  enabled: boolean;
  phase: ScheduleProposalPhase;
  createdAt: string;
  resolvedAt?: string;
  /** ShipIt's own account of an ending that is not `confirmed` or `cancelled`. */
  outcome?: string;
}
