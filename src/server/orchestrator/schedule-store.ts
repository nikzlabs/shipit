import { randomUUID } from "node:crypto";
import type { DatabaseManager } from "../shared/database.js";
import type { Schedule, ScheduleRun, ScheduleRunOutcome, ScheduleTiming } from "../shared/types.js";

/**
 * docs/324-scheduled-sessions plan.md → Storage. The store keeps what it is given;
 * when `active_since` moves and when the reason clears are the scheduler's rules.
 */

interface ScheduleRow {
  id: string;
  name: string;
  enabled: number;
  timing: string;
  time_zone: string;
  spec: string;
  active_since: string;
  needs_user_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  schedule_id: string;
  slot_at: string | null;
  spec: string | null;
  outcome: string;
  reason: string | null;
  session_id: string | null;
  result: string | null;
  started_at: string | null;
  created_at: string;
}

export interface NewSchedule {
  name: string;
  enabled?: boolean;
  timing: ScheduleTiming;
  timeZone: string;
  spec: unknown;
}

/** What a user's edit can change; each one moves `updated_at`. */
export type ScheduleChanges = Partial<Pick<Schedule, "name" | "enabled" | "timing" | "timeZone" | "spec" | "activeSince">>;

export interface NewScheduleRun {
  scheduleId: string;
  /** The slot this row claims; null for Run now, which never collides. */
  slotAt: Date | null;
  spec?: unknown;
  outcome?: ScheduleRunOutcome;
  reason?: string;
}

export interface ScheduleRunChanges {
  outcome?: ScheduleRunOutcome;
  /** Null clears it. */
  reason?: string | null;
  sessionId?: string;
  result?: string;
  startedAt?: string;
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
}

function fromRow(row: ScheduleRow): Schedule {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    timing: parseJson(row.timing) as ScheduleTiming,
    timeZone: row.time_zone,
    spec: parseJson(row.spec),
    activeSince: row.active_since,
    ...(row.needs_user_reason ? { needsUserReason: row.needs_user_reason } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function runFromRow(row: RunRow): ScheduleRun {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    slotAt: row.slot_at,
    ...(row.spec === null ? {} : { spec: parseJson(row.spec) }),
    outcome: row.outcome as ScheduleRunOutcome,
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.result ? { result: row.result } : {}),
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    createdAt: row.created_at,
  };
}

export class ScheduleStore {
  private db;

  constructor(dbManager: DatabaseManager) {
    this.db = dbManager.db;
  }

  create(input: NewSchedule, now = new Date().toISOString()): Schedule {
    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO schedules
         (id, name, enabled, timing, time_zone, spec, active_since, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.name,
      input.enabled === false ? 0 : 1,
      JSON.stringify(input.timing),
      input.timeZone,
      JSON.stringify(input.spec ?? null),
      now,
      now,
      now,
    );
    return this.get(id)!;
  }

  get(id: string): Schedule | null {
    const row = this.db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as ScheduleRow | undefined;
    return row ? fromRow(row) : null;
  }

  list(): Schedule[] {
    const rows = this.db.prepare("SELECT * FROM schedules ORDER BY created_at, rowid").all() as ScheduleRow[];
    return rows.map(fromRow);
  }

  update(id: string, changes: ScheduleChanges, now = new Date().toISOString()): Schedule | null {
    const sets: string[] = ["updated_at = ?"];
    const params: unknown[] = [now];
    const set = (column: string, value: unknown) => {
      sets.push(`${column} = ?`);
      params.push(value);
    };
    if (changes.name !== undefined) set("name", changes.name);
    if (changes.enabled !== undefined) set("enabled", changes.enabled ? 1 : 0);
    if (changes.timing !== undefined) set("timing", JSON.stringify(changes.timing));
    if (changes.timeZone !== undefined) set("time_zone", changes.timeZone);
    if ("spec" in changes) set("spec", JSON.stringify(changes.spec ?? null));
    if (changes.activeSince !== undefined) set("active_since", changes.activeSince);
    const res = this.db.prepare(`UPDATE schedules SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
    return res.changes > 0 ? this.get(id) : null;
  }

  /**
   * Req 18. Not an edit, so `updated_at` stays: a proposal card that recorded it
   * must not go stale because a start failed.
   */
  setNeedsUserReason(id: string, reason: string | null): void {
    this.db.prepare("UPDATE schedules SET needs_user_reason = ? WHERE id = ?").run(reason, id);
  }

  /** Removes the run history with it; run sessions keep their schedule ids (req 32). */
  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM schedules WHERE id = ?").run(id).changes > 0;
  }

  /** Null when another row already claimed the slot. */
  insertRun(input: NewScheduleRun, now = new Date().toISOString()): ScheduleRun | null {
    const id = randomUUID();
    const res = this.db.prepare(
      `INSERT INTO schedule_runs (id, schedule_id, slot_at, spec, outcome, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (schedule_id, slot_at) DO NOTHING`,
    ).run(
      id,
      input.scheduleId,
      input.slotAt?.toISOString() ?? null,
      input.spec === undefined ? null : JSON.stringify(input.spec),
      input.outcome ?? "starting",
      input.reason ?? null,
      now,
    );
    return res.changes > 0 ? this.getRun(id) : null;
  }

  getRun(id: string): ScheduleRun | null {
    const row = this.db.prepare("SELECT * FROM schedule_runs WHERE id = ?").get(id) as RunRow | undefined;
    return row ? runFromRow(row) : null;
  }

  updateRun(id: string, changes: ScheduleRunChanges): ScheduleRun | null {
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (column: string, value: unknown) => {
      sets.push(`${column} = ?`);
      params.push(value);
    };
    if (changes.outcome !== undefined) set("outcome", changes.outcome);
    if (changes.reason !== undefined) set("reason", changes.reason);
    if (changes.sessionId !== undefined) set("session_id", changes.sessionId);
    if (changes.result !== undefined) set("result", changes.result);
    if (changes.startedAt !== undefined) set("started_at", changes.startedAt);
    if (sets.length > 0) {
      this.db.prepare(`UPDATE schedule_runs SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
    }
    return this.getRun(id);
  }

  /** Newest first (req 24). */
  listRuns(scheduleId: string, limit?: number): ScheduleRun[] {
    const rows = this.db.prepare(
      "SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
    ).all(scheduleId, limit ?? -1) as RunRow[];
    return rows.map(runFromRow);
  }

  /** Where the walk for due slots resumes; every slot is stored as `toISOString()`, so MAX orders them. */
  latestSlotAt(scheduleId: string): string | null {
    const row = this.db.prepare("SELECT MAX(slot_at) AS at FROM schedule_runs WHERE schedule_id = ?")
      .get(scheduleId) as { at: string | null };
    return row.at;
  }
}
