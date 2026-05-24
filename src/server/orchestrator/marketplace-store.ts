/**
 * Persistence for the marketplaces table (docs/149 — skill install UX).
 *
 * App-wide state: one catalog list shared across every session. Each row pairs
 * a short id (`claude-plugins-official`) with a {@link MarketplaceSource} and
 * the agent backend the catalog applies to. The Discover sub-tab filters by
 * the active session's agent so a Claude session never sees a Codex catalog.
 *
 * v1 seeds one row at startup (the official Claude catalog) and never inserts
 * or deletes after that. The fetch-status columns (`status`, `last_fetched_at`,
 * `fetch_error`) are written by the marketplace service on each background
 * pre-clone / on-demand refresh.
 *
 * Matches the SQLite-via-DatabaseManager pattern used by `repo-store.ts` and
 * `secret-store.ts`. Marketplaces are queryable domain data, not credentials,
 * so this is the right layer — not a JSON-file store like `credential-store.ts`.
 */

import type { DatabaseManager } from "../shared/database.js";
import type {
  AgentId,
  MarketplaceInfo,
  MarketplaceSource,
  MarketplaceStatus,
} from "../shared/types.js";

interface MarketplaceRow {
  id: string;
  source: string;
  agent_id: string;
  auto_update: number;
  status: string;
  last_fetched_at: string | null;
  fetch_error: string | null;
}

export class MarketplaceStore {
  private db;

  constructor(dbManager: DatabaseManager) {
    this.db = dbManager.db;
  }

  private fromRow(row: MarketplaceRow): MarketplaceInfo {
    const info: MarketplaceInfo = {
      id: row.id,
      source: JSON.parse(row.source) as MarketplaceSource,
      agentId: row.agent_id as AgentId,
      autoUpdate: row.auto_update !== 0,
      status: row.status as MarketplaceStatus,
    };
    if (row.last_fetched_at) info.lastFetchedAt = row.last_fetched_at;
    if (row.fetch_error) info.fetchError = row.fetch_error;
    return info;
  }

  /** List every marketplace, optionally filtered by agent. Sorted by id. */
  list(agentId?: AgentId): MarketplaceInfo[] {
    const rows = (agentId
      ? this.db.prepare("SELECT * FROM marketplaces WHERE agent_id = ? ORDER BY id").all(agentId)
      : this.db.prepare("SELECT * FROM marketplaces ORDER BY id").all()) as MarketplaceRow[];
    return rows.map((r) => this.fromRow(r));
  }

  get(id: string): MarketplaceInfo | undefined {
    const row = this.db.prepare("SELECT * FROM marketplaces WHERE id = ?").get(id) as
      | MarketplaceRow
      | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  /**
   * Insert a new marketplace, or no-op if the id already exists. Used at
   * startup to seed the official catalogs without overwriting prior fetch
   * state. v2 will add a true `add` verb for user-added marketplaces.
   */
  seedIfMissing(info: Pick<MarketplaceInfo, "id" | "source" | "agentId" | "autoUpdate">): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO marketplaces (id, source, agent_id, auto_update, status)
       VALUES (?, ?, ?, ?, 'loading')`,
    ).run(info.id, JSON.stringify(info.source), info.agentId, info.autoUpdate ? 1 : 0);
  }

  /** Record the outcome of a catalog fetch attempt. */
  setFetchStatus(
    id: string,
    status: MarketplaceStatus,
    opts: { lastFetchedAt?: string; fetchError?: string | null } = {},
  ): void {
    this.db.prepare(
      `UPDATE marketplaces
          SET status = ?,
              last_fetched_at = COALESCE(?, last_fetched_at),
              fetch_error = ?
        WHERE id = ?`,
    ).run(
      status,
      opts.lastFetchedAt ?? null,
      opts.fetchError ?? null,
      id,
    );
  }
}
