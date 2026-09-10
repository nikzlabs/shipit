import type { DatabaseManager } from "../shared/database.js";

export interface PersistedPresentation {
  presentId: string;
  sessionId: string;
  filePath: string;
  /** Container path used to re-register metadata after restart; bytes are not stored here. */
  resolvedPath: string;
  mimeType: string;
  title?: string;
  createdAt: string;
  inline?: boolean;
}

export interface PresentMetaForClient {
  presentId: string;
  mimeType: string;
  title?: string;
  filePath: string;
  createdAt: string;
  inline?: boolean;
}

interface PresentRow {
  present_id: string;
  session_id: string;
  file_path: string;
  resolved_path: string;
  mime_type: string;
  title: string | null;
  created_at: string;
  inline: number | null;
}

export class PresentStore {
  constructor(private readonly dbm: DatabaseManager) {}

  private get db() {
    return this.dbm.db;
  }

  record(entry: PersistedPresentation): { inlineCardIsNew: boolean } {
    const titleValue = entry.title ?? null;
    const inlineValue = entry.inline ? 1 : 0;

    // Preserve carousel order and the inline flag. Determine card creation in
    // the same transaction so concurrent updates cannot emit duplicate cards.
    const run = this.db.transaction((): { inlineCardIsNew: boolean } => {
      const before = this.db
        .prepare("SELECT inline FROM presentations WHERE present_id = ?")
        .get(entry.presentId) as { inline: number | null } | undefined;
      this.db
        .prepare(
          `INSERT INTO presentations
             (present_id, session_id, file_path, resolved_path, mime_type, title, created_at, inline)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(present_id) DO UPDATE SET
             file_path = excluded.file_path,
             resolved_path = excluded.resolved_path,
             mime_type = excluded.mime_type,
             title = excluded.title,
             created_at = excluded.created_at,
             inline = MAX(presentations.inline, excluded.inline)`,
        )
        .run(
          entry.presentId,
          entry.sessionId,
          entry.filePath,
          entry.resolvedPath,
          entry.mimeType,
          titleValue,
          entry.createdAt,
          inlineValue,
        );
      return { inlineCardIsNew: inlineValue === 1 && !before?.inline };
    });
    return run();
  }

  clear(sessionId: string, presentId?: string): void {
    if (presentId === undefined) {
      this.db.prepare("DELETE FROM presentations WHERE session_id = ?").run(sessionId);
      return;
    }
    this.db
      .prepare("DELETE FROM presentations WHERE session_id = ? AND present_id = ?")
      .run(sessionId, presentId);
  }

  deleteSession(sessionId: string): void {
    this.db.prepare("DELETE FROM presentations WHERE session_id = ?").run(sessionId);
  }

  list(sessionId: string): PersistedPresentation[] {
    const rows = this.db
      .prepare("SELECT * FROM presentations WHERE session_id = ? ORDER BY id ASC")
      .all(sessionId) as PresentRow[];
    return rows.map(fromRow);
  }

  listForClient(sessionId: string): PresentMetaForClient[] {
    return this.list(sessionId).map((p) => ({
      presentId: p.presentId,
      mimeType: p.mimeType,
      filePath: p.filePath,
      createdAt: p.createdAt,
      ...(p.title !== undefined ? { title: p.title } : {}),
      ...(p.inline ? { inline: true } : {}),
    }));
  }

  get(presentId: string): PersistedPresentation | undefined {
    const row = this.db
      .prepare("SELECT * FROM presentations WHERE present_id = ?")
      .get(presentId) as PresentRow | undefined;
    return row ? fromRow(row) : undefined;
  }
}

function fromRow(row: PresentRow): PersistedPresentation {
  return {
    presentId: row.present_id,
    sessionId: row.session_id,
    filePath: row.file_path,
    resolvedPath: row.resolved_path,
    mimeType: row.mime_type,
    createdAt: row.created_at,
    ...(row.title !== null ? { title: row.title } : {}),
    ...(row.inline ? { inline: true } : {}),
  };
}
