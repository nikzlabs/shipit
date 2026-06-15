/**
 * PresentStore — durable, session-scoped metadata for the Present tab (docs/093).
 *
 * Presentations used to live only in memory (the worker's `PresentRegistry`, the
 * orchestrator runner's `_presentations` cache, and the client store). All three
 * are wiped when the session container is recycled (idle eviction), so the
 * Present tab came back empty after a restart even when the artifact's source
 * file was a committed workspace file still on disk. This store is the
 * orchestrator-side persistence layer that survives a fresh container: a new
 * runner seeds `_presentations` from here, and `proxyPresentRaw` re-registers a
 * persisted entry with the freshly-started worker so its bytes can be served
 * again.
 *
 * It holds METADATA only — never the artifact bytes. `resolvedPath` is the
 * container-internal absolute path the worker recorded; the orchestrator passes
 * it back to a fresh worker on re-register, which then re-reads the file from
 * disk on demand. A workspace-committed artifact re-renders fully after a
 * restart; a `/tmp` throwaway whose file is gone serves a graceful 404 (the
 * Present tab shows a "no longer available" placeholder).
 *
 * Ordering: rows sort by the insertion-order `id` rowid. A `replaceId` revision
 * (mockup v1 → v2) updates the superseded row IN PLACE so it keeps its carousel
 * slot, mirroring the client store's reducer and the runner's `cachePresentation`.
 */

import type { DatabaseManager } from "../shared/database.js";

/** The full persisted record — includes the container-internal `resolvedPath`. */
export interface PersistedPresentation {
  presentId: string;
  sessionId: string;
  /** The path the agent presented (verbatim) — shown in the Present tab header. */
  filePath: string;
  /** Absolute container-internal path; re-read on demand / re-registered after restart. */
  resolvedPath: string;
  mimeType: string;
  title?: string;
  createdAt: string;
}

/** The client-facing metadata subset (no `resolvedPath`) — matches `PresentStateEntry`. */
export interface PresentMetaForClient {
  presentId: string;
  mimeType: string;
  title?: string;
  filePath: string;
  createdAt: string;
}

interface PresentRow {
  present_id: string;
  session_id: string;
  file_path: string;
  resolved_path: string;
  mime_type: string;
  title: string | null;
  created_at: string;
}

export class PresentStore {
  constructor(private readonly dbm: DatabaseManager) {}

  private get db() {
    return this.dbm.db;
  }

  /**
   * Record (or revise) a presentation's metadata, mirroring the runner's
   * `cachePresentation` reducer:
   *  - `replaceId` points at a known row (revision) → update that row in place,
   *    swapping in the new `present_id` + fields, keeping its insertion-order id
   *    (so the carousel slot is preserved).
   *  - the new `present_id` already exists (idempotent re-delivery) → update it.
   *  - otherwise → insert a new row (appends to the end).
   */
  record(entry: PersistedPresentation, replaceId?: string): void {
    const titleValue = entry.title ?? null;

    if (replaceId) {
      const existing = this.db
        .prepare("SELECT id FROM presentations WHERE present_id = ? AND session_id = ?")
        .get(replaceId, entry.sessionId) as { id: number } | undefined;
      if (existing) {
        this.db
          .prepare(
            `UPDATE presentations
               SET present_id = ?, file_path = ?, resolved_path = ?, mime_type = ?, title = ?, created_at = ?
             WHERE id = ?`,
          )
          .run(
            entry.presentId,
            entry.filePath,
            entry.resolvedPath,
            entry.mimeType,
            titleValue,
            entry.createdAt,
            existing.id,
          );
        return;
      }
    }

    // Upsert by the natural unique key. ON CONFLICT keeps the existing row's id
    // (insertion order) while refreshing its fields — the idempotent-redelivery
    // path — and a brand-new id otherwise appends.
    this.db
      .prepare(
        `INSERT INTO presentations
           (present_id, session_id, file_path, resolved_path, mime_type, title, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(present_id) DO UPDATE SET
           file_path = excluded.file_path,
           resolved_path = excluded.resolved_path,
           mime_type = excluded.mime_type,
           title = excluded.title,
           created_at = excluded.created_at`,
      )
      .run(
        entry.presentId,
        entry.sessionId,
        entry.filePath,
        entry.resolvedPath,
        entry.mimeType,
        titleValue,
        entry.createdAt,
      );
  }

  /** Drop one presentation (a revision superseding an id), or all for a session. */
  clear(sessionId: string, presentId?: string): void {
    if (presentId === undefined) {
      this.db.prepare("DELETE FROM presentations WHERE session_id = ?").run(sessionId);
      return;
    }
    this.db
      .prepare("DELETE FROM presentations WHERE session_id = ? AND present_id = ?")
      .run(sessionId, presentId);
  }

  /** Drop every presentation for a session (permanent delete / full reset). */
  deleteSession(sessionId: string): void {
    this.db.prepare("DELETE FROM presentations WHERE session_id = ?").run(sessionId);
  }

  /** Full persisted records (incl. `resolvedPath`) for a session, in carousel order. */
  list(sessionId: string): PersistedPresentation[] {
    const rows = this.db
      .prepare("SELECT * FROM presentations WHERE session_id = ? ORDER BY id ASC")
      .all(sessionId) as PresentRow[];
    return rows.map(fromRow);
  }

  /** Client-facing metadata (no `resolvedPath`) for a session, in carousel order. */
  listForClient(sessionId: string): PresentMetaForClient[] {
    return this.list(sessionId).map((p) => ({
      presentId: p.presentId,
      mimeType: p.mimeType,
      filePath: p.filePath,
      createdAt: p.createdAt,
      ...(p.title !== undefined ? { title: p.title } : {}),
    }));
  }

  /** One full record by id — used by `proxyPresentRaw` to re-register after a restart. */
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
  };
}
