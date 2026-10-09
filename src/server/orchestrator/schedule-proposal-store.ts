import type { DatabaseManager } from "../shared/database.js";
import type { ScheduleProposalPhase, ScheduleTiming, SessionStartSpec } from "../shared/types.js";

/**
 * The private half of a schedule proposal card (docs/324-scheduled-sessions req 9). Confirm
 * writes what this record holds, so a decision names only a card and never a value.
 */

/** A new schedule, with no zone when Confirm is to use the browser's. */
export interface ScheduleCreateProposal {
  kind: "create";
  name: string;
  timing: ScheduleTiming;
  timeZone: string | null;
  spec: SessionStartSpec;
  enabled: boolean;
}

/** Only what changes, each with its whole new value. */
export interface ScheduleUpdateProposal {
  kind: "update";
  changes: {
    name?: string;
    timing?: ScheduleTiming;
    timeZone?: string;
    spec?: SessionStartSpec;
    enabled?: boolean;
  };
}

export type ScheduleProposal = ScheduleCreateProposal | ScheduleUpdateProposal;

export interface ScheduleProposalRecord {
  cardId: string;
  sessionId: string;
  /** The schedule a change is about, or the one Confirm created. */
  scheduleId?: string;
  /** A change card's `updated_at` of its schedule: Confirm refuses when the schedule has moved since. */
  baseUpdatedAt?: string;
  proposal: ScheduleProposal;
  phase: ScheduleProposalPhase;
  createdAt: string;
  resolvedAt?: string;
  agentNotified: boolean;
}

interface Row {
  card_id: string;
  session_id: string;
  schedule_id: string | null;
  base_updated_at: string | null;
  proposal: string;
  phase: string;
  created_at: string;
  resolved_at: string | null;
  agent_notified: number;
}

function fromRow(row: Row): ScheduleProposalRecord {
  return {
    cardId: row.card_id,
    sessionId: row.session_id,
    ...(row.schedule_id ? { scheduleId: row.schedule_id } : {}),
    ...(row.base_updated_at ? { baseUpdatedAt: row.base_updated_at } : {}),
    proposal: JSON.parse(row.proposal) as ScheduleProposal,
    phase: row.phase as ScheduleProposalPhase,
    createdAt: row.created_at,
    ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
    agentNotified: row.agent_notified === 1,
  };
}

export class ScheduleProposalStore {
  private db;

  constructor(dbManager: DatabaseManager) {
    this.db = dbManager.db;
  }

  create(record: Omit<ScheduleProposalRecord, "resolvedAt" | "agentNotified">): void {
    this.db.prepare(
      `INSERT INTO schedule_proposals
         (card_id, session_id, schedule_id, base_updated_at, proposal, phase, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.cardId,
      record.sessionId,
      record.scheduleId ?? null,
      record.baseUpdatedAt ?? null,
      JSON.stringify(record.proposal),
      record.phase,
      record.createdAt,
    );
  }

  get(cardId: string): ScheduleProposalRecord | null {
    const row = this.db.prepare("SELECT * FROM schedule_proposals WHERE card_id = ?").get(cardId) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  /** The record and the transcript row commit together; they are in the same database. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  setPhase(sessionId: string, cardId: string, phase: ScheduleProposalPhase, resolvedAt?: string): boolean {
    return this.db.prepare(
      "UPDATE schedule_proposals SET phase = ?, resolved_at = COALESCE(?, resolved_at) WHERE card_id = ? AND session_id = ?",
    ).run(phase, resolvedAt ?? null, cardId, sessionId).changes > 0;
  }

  /** The update is the test, so of two racing clicks only one moves the record. */
  claimPhase(
    sessionId: string,
    cardId: string,
    from: ScheduleProposalPhase,
    to: ScheduleProposalPhase,
    resolvedAt?: string,
  ): boolean {
    return this.db.prepare(
      "UPDATE schedule_proposals SET phase = ?, resolved_at = COALESCE(?, resolved_at) "
        + "WHERE card_id = ? AND session_id = ? AND phase = ?",
    ).run(to, resolvedAt ?? null, cardId, sessionId, from).changes > 0;
  }

  /** Records the schedule Confirm created. */
  setScheduleId(sessionId: string, cardId: string, scheduleId: string): void {
    this.db.prepare("UPDATE schedule_proposals SET schedule_id = ? WHERE card_id = ? AND session_id = ?")
      .run(scheduleId, cardId, sessionId);
  }

  /** One session's resolved cards the agent has not been told about, oldest first. A read, not a consume. */
  listUnnotifiedResolved(sessionId: string): ScheduleProposalRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM schedule_proposals
       WHERE session_id = ? AND agent_notified = 0 AND phase != 'pending'
       ORDER BY created_at, rowid`,
    ).all(sessionId) as Row[];
    return rows.map(fromRow);
  }

  markAgentNotified(sessionId: string, cardIds: readonly string[]): void {
    if (cardIds.length === 0) return;
    const stmt = this.db.prepare(
      "UPDATE schedule_proposals SET agent_notified = 1 WHERE card_id = ? AND session_id = ?",
    );
    this.db.transaction(() => {
      for (const cardId of cardIds) stmt.run(cardId, sessionId);
    })();
  }
}
