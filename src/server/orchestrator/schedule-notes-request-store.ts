import type { DatabaseManager } from "../shared/database.js";
import type { ScheduleNotesAccessPhase } from "../shared/types.js";

/**
 * The private half of a notes access card (docs/324-scheduled-sessions reqs 28, 30): which
 * schedule Allow grants. A decision names only the card, never a schedule.
 */

export interface ScheduleNotesRequest {
  cardId: string;
  sessionId: string;
  scheduleId: string;
  phase: ScheduleNotesAccessPhase;
  createdAt: string;
  resolvedAt?: string;
  agentNotified: boolean;
}

interface Row {
  card_id: string;
  session_id: string;
  schedule_id: string;
  phase: string;
  created_at: string;
  resolved_at: string | null;
  agent_notified: number;
}

function fromRow(row: Row): ScheduleNotesRequest {
  return {
    cardId: row.card_id,
    sessionId: row.session_id,
    scheduleId: row.schedule_id,
    phase: row.phase as ScheduleNotesAccessPhase,
    createdAt: row.created_at,
    ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
    agentNotified: row.agent_notified === 1,
  };
}

export class ScheduleNotesRequestStore {
  private db;

  constructor(dbManager: DatabaseManager) {
    this.db = dbManager.db;
  }

  create(record: Omit<ScheduleNotesRequest, "resolvedAt" | "agentNotified">): void {
    this.db.prepare(
      `INSERT INTO schedule_notes_requests (card_id, session_id, schedule_id, phase, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(record.cardId, record.sessionId, record.scheduleId, record.phase, record.createdAt);
  }

  get(cardId: string): ScheduleNotesRequest | null {
    const row = this.db.prepare("SELECT * FROM schedule_notes_requests WHERE card_id = ?").get(cardId) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  /** The card still waiting for the user, so a second ask does not post a second card. */
  pending(sessionId: string, scheduleId: string): ScheduleNotesRequest | null {
    const row = this.db.prepare(
      `SELECT * FROM schedule_notes_requests
       WHERE session_id = ? AND schedule_id = ? AND phase = 'pending'
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(sessionId, scheduleId) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  /** A pending request whose card left the transcript, as a rewind past it does. */
  delete(cardId: string): void {
    this.db.prepare("DELETE FROM schedule_notes_requests WHERE card_id = ?").run(cardId);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  setPhase(sessionId: string, cardId: string, phase: ScheduleNotesAccessPhase, resolvedAt?: string): boolean {
    return this.db.prepare(
      "UPDATE schedule_notes_requests SET phase = ?, resolved_at = COALESCE(?, resolved_at) WHERE card_id = ? AND session_id = ?",
    ).run(phase, resolvedAt ?? null, cardId, sessionId).changes > 0;
  }

  /** The update is the test, so of two racing clicks only one moves the record. */
  claimPhase(
    sessionId: string,
    cardId: string,
    from: ScheduleNotesAccessPhase,
    to: ScheduleNotesAccessPhase,
    resolvedAt?: string,
  ): boolean {
    return this.db.prepare(
      "UPDATE schedule_notes_requests SET phase = ?, resolved_at = COALESCE(?, resolved_at) "
        + "WHERE card_id = ? AND session_id = ? AND phase = ?",
    ).run(to, resolvedAt ?? null, cardId, sessionId, from).changes > 0;
  }

  /** One session's decided cards the agent has not been told about, oldest first. A read, not a consume. */
  listUnnotifiedResolved(sessionId: string): ScheduleNotesRequest[] {
    const rows = this.db.prepare(
      `SELECT * FROM schedule_notes_requests
       WHERE session_id = ? AND agent_notified = 0 AND phase != 'pending'
       ORDER BY created_at, rowid`,
    ).all(sessionId) as Row[];
    return rows.map(fromRow);
  }

  markAgentNotified(sessionId: string, cardIds: readonly string[]): void {
    if (cardIds.length === 0) return;
    const stmt = this.db.prepare(
      "UPDATE schedule_notes_requests SET agent_notified = 1 WHERE card_id = ? AND session_id = ?",
    );
    this.db.transaction(() => {
      for (const cardId of cardIds) stmt.run(cardId, sessionId);
    })();
  }
}
