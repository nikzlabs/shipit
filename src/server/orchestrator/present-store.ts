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
 * Ordering: rows sort by the insertion-order `id` rowid. `present_id` is
 * content-addressed by the file path, so re-presenting the same file upserts the
 * existing row IN PLACE (`ON CONFLICT(present_id)`), keeping its carousel slot;
 * a different file inserts a new row. This mirrors the client store's reducer
 * and the runner's `cachePresentation`.
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
  /**
   * docs/280 — the artifact also has a card in the chat transcript. STICKY: once
   * true it never goes back to false, because the card is already in the
   * scrollback and a later plain re-present (the screenshot loop) must not
   * pretend it isn't. `record` enforces that with a MAX() upsert.
   */
  inline?: boolean;
}

/** The client-facing metadata subset (no `resolvedPath`) — matches `PresentStateEntry`. */
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

  /**
   * Record a presentation's metadata, mirroring the runner's `cachePresentation`
   * reducer. `present_id` is content-addressed by the file path, so:
   *  - re-presenting the same file (same `present_id`) → `ON CONFLICT` updates
   *    the existing row in place, keeping its insertion-order id (carousel slot).
   *  - a different file (new `present_id`) → inserts a new row (appends).
   *
   * Returns whether this call is the moment the artifact BECAME inline —
   * `true` exactly once per artifact, on the first `present({ inline: true })`
   * for that path. That answer is the emit gate for the transcript card
   * (docs/280): the screenshot loop re-presents the same path over and over, and
   * every one of those must refresh the existing card rather than append another
   * one showing identical bytes. Computing it here, inside the same write that
   * flips the flag, is what keeps two concurrent presents from both reading
   * "not inline yet" and emitting two cards.
   */
  record(entry: PersistedPresentation): { inlineCardIsNew: boolean } {
    const titleValue = entry.title ?? null;
    const inlineValue = entry.inline ? 1 : 0;

    // Upsert by the natural unique key. ON CONFLICT keeps the existing row's id
    // (insertion order) while refreshing its fields — the same-file re-present
    // path — and a brand-new id otherwise appends.
    //
    // `inline` is the one field the upsert does NOT simply overwrite: MAX() makes
    // it sticky, so a plain re-present can never demote an artifact that already
    // has a transcript card.
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

  /** Drop one presentation by id, or all for a session (session switch / full clear). */
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
      ...(p.inline ? { inline: true } : {}),
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
    ...(row.inline ? { inline: true } : {}),
  };
}
