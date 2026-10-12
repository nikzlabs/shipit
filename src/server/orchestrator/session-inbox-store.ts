import type { DatabaseManager } from "../shared/database.js";
import type { SessionMessageOrigin } from "../shared/types.js";

export interface InboxMessage {
  id: number;
  sessionId: string;
  /** Absent for a notice that ShipIt wrote itself. */
  origin?: SessionMessageOrigin;
  body: string;
  createdAt: string;
}

export interface NewInboxMessage {
  origin?: SessionMessageOrigin;
  body: string;
}

/** What a session's agent has not read and has not been told about. */
export interface OwedInboxNotice {
  /** The newest message the notice covers. */
  through: number;
  /** The newest message that the agent has read or has been told about: the notice covers what follows it. */
  since: number;
  unread: number;
  /** False when a message the user approved is among those not told yet (docs/322 req 6). */
  automatic: boolean;
}

interface InboxRow {
  id: number;
  session_id: string;
  from_session_id: string | null;
  from_title: string | null;
  relation: string | null;
  body: string;
  created_at: string;
}

function fromRow(row: InboxRow): InboxMessage {
  const origin = row.from_session_id !== null && row.relation !== null
    ? {
        sessionId: row.from_session_id,
        sessionTitle: row.from_title ?? "",
        relation: row.relation as SessionMessageOrigin["relation"],
      }
    : undefined;
  return {
    id: row.id,
    sessionId: row.session_id,
    ...(origin ? { origin } : {}),
    body: row.body,
    createdAt: row.created_at,
  };
}

/** docs/328-session-message-inbox — the messages sent to each session, and its two cursors. */
export class SessionInboxStore {
  constructor(private readonly dbm: Pick<DatabaseManager, "db">) {}

  private get db() {
    return this.dbm.db;
  }

  add(sessionId: string, message: NewInboxMessage): InboxMessage {
    const createdAt = new Date().toISOString();
    const id = Number(
      this.db
        .prepare(
          `INSERT INTO session_inbox (session_id, from_session_id, from_title, relation, body, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sessionId,
          message.origin?.sessionId ?? null,
          message.origin?.sessionTitle ?? null,
          message.origin?.relation ?? null,
          message.body,
          createdAt,
        ).lastInsertRowid,
    );
    return { id, sessionId, ...(message.origin ? { origin: message.origin } : {}), body: message.body, createdAt };
  }

  all(sessionId: string): InboxMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM session_inbox WHERE session_id = ? ORDER BY id")
      .all(sessionId) as InboxRow[];
    return rows.map(fromRow);
  }

  /** Oldest first, and marks nothing. */
  unread(sessionId: string): InboxMessage[] {
    return this.unreadRows(sessionId).map(fromRow);
  }

  /** Oldest first. One transaction, so a message stored during the read is in this batch or the next. */
  takeUnread(sessionId: string): InboxMessage[] {
    return this.db.transaction((): InboxMessage[] => {
      const unread = this.unread(sessionId);
      const last = unread.at(-1);
      if (last) this.markRead(sessionId, last.id);
      return unread;
    })();
  }

  markRead(sessionId: string, through: number): void {
    this.db
      .prepare(
        `INSERT INTO session_inbox_state (session_id, read_through) VALUES (?, ?)
         ON CONFLICT(session_id) DO UPDATE SET read_through = MAX(read_through, excluded.read_through)`,
      )
      .run(sessionId, through);
  }

  owed(sessionId: string): OwedInboxNotice | undefined {
    const unread = this.unreadRows(sessionId);
    const last = unread.at(-1);
    if (!last) return undefined;
    const { readThrough, notifiedThrough } = this.state(sessionId);
    if (last.id <= notifiedThrough) return undefined;
    return {
      through: last.id,
      since: Math.max(readThrough, notifiedThrough),
      unread: unread.length,
      automatic: !unread.some((m) => m.id > notifiedThrough && m.relation === "proposed"),
    };
  }

  markNotified(sessionId: string, through: number): void {
    this.db
      .prepare(
        `INSERT INTO session_inbox_state (session_id, notified_through) VALUES (?, ?)
         ON CONFLICT(session_id) DO UPDATE SET notified_through = MAX(notified_through, excluded.notified_through)`,
      )
      .run(sessionId, through);
  }

  sessionsOwed(): string[] {
    const rows = this.db
      .prepare(
        `SELECT i.session_id AS session_id
           FROM session_inbox i
           LEFT JOIN session_inbox_state s ON s.session_id = i.session_id
          GROUP BY i.session_id
         HAVING MAX(i.id) > MAX(COALESCE(s.read_through, 0), COALESCE(s.notified_through, 0))`,
      )
      .all() as { session_id: string }[];
    return rows.map((r) => r.session_id);
  }

  private state(sessionId: string): { readThrough: number; notifiedThrough: number } {
    const row = this.db
      .prepare("SELECT read_through, notified_through FROM session_inbox_state WHERE session_id = ?")
      .get(sessionId) as { read_through: number; notified_through: number } | undefined;
    return { readThrough: row?.read_through ?? 0, notifiedThrough: row?.notified_through ?? 0 };
  }

  private unreadRows(sessionId: string): InboxRow[] {
    return this.db
      .prepare("SELECT * FROM session_inbox WHERE session_id = ? AND id > ? ORDER BY id")
      .all(sessionId, this.state(sessionId).readThrough) as InboxRow[];
  }
}
