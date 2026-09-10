import type { RepoInfo } from "../shared/types.js";
import type { DatabaseManager } from "../shared/database.js";
import { isValidRepoColorIndex, pickRepoColorIndex } from "../shared/repo-colors.js";
import { canonicalRepoKey, hasUrlCredentials, repoId, stripRemoteUrlCredentials } from "./git-utils.js";

interface RepoRow {
  url: string;
  added_at: string;
  last_used_at: string;
  status: string;
  warm_session_id: string | null;
  trusted: number;
  hidden: number;
  allow_agent_merge: number;
  default_branch: string | null;
  color_index: number | null;
}

export class RepoStore {
  private db;

  constructor(dbManager: DatabaseManager) {
    this.db = dbManager.db;
  }

  // Strip credentials on reads and writes, but preserve the cloneable URL.
  private key(url: string): string {
    return stripRemoteUrlCredentials(url);
  }

  private fromRow(row: RepoRow): RepoInfo {
    const info: RepoInfo = {
      url: row.url,
      addedAt: row.added_at,
      lastUsedAt: row.last_used_at,
      status: row.status as RepoInfo["status"],
    };
    if (row.warm_session_id) info.warmSessionId = row.warm_session_id;
    info.trusted = row.trusted === 1;
    info.hidden = row.hidden === 1;
    info.allowAgentMerge = row.allow_agent_merge === 1;
    if (row.default_branch) info.defaultBranch = row.default_branch;
    if (isValidRepoColorIndex(row.color_index)) info.colorIndex = row.color_index;
    return info;
  }

  add(url: string): RepoInfo {
    const key = this.key(url);
    const existing = this.get(key);
    if (existing) {
      this.db.prepare("UPDATE repos SET last_used_at = ?, hidden = 0 WHERE url = ?").run(new Date().toISOString(), key);
      if (existing.colorIndex === undefined) {
        this.db.prepare("UPDATE repos SET color_index = ? WHERE url = ?").run(this.nextColorIndex(), key);
      }
      return this.get(key)!;
    }
    const now = new Date().toISOString();
    this.db.prepare(
      "INSERT INTO repos (url, added_at, last_used_at, status, color_index) VALUES (?, ?, ?, 'cloning', ?)",
    ).run(key, now, now, this.nextColorIndex());
    return this.get(key)!;
  }

  // Merge collisions to retain trust and warm-session state; return URL moves for cache migration.
  scrubCredentialedUrls(): { from: string; to: string }[] {
    const rows = this.db.prepare("SELECT * FROM repos").all() as RepoRow[];
    const affected = rows.filter((r) => hasUrlCredentials(r.url));
    if (affected.length === 0) return [];
    const cleaned: { from: string; to: string }[] = [];
    const tx = this.db.transaction(() => {
      for (const row of affected) {
        const clean = this.key(row.url);
        const twin = this.db.prepare("SELECT * FROM repos WHERE url = ?").get(clean) as RepoRow | undefined;
        if (twin) {
          this.db.prepare(
            `UPDATE repos SET
               trusted = MAX(trusted, ?),
               status = CASE WHEN status = 'ready' OR ? = 'ready' THEN 'ready' ELSE status END,
               hidden = MIN(hidden, ?),
               warm_session_id = COALESCE(warm_session_id, ?),
               default_branch = COALESCE(default_branch, ?),
               color_index = COALESCE(color_index, ?),
               display_order = COALESCE(display_order, (SELECT display_order FROM repos WHERE url = ?))
             WHERE url = ?`,
          ).run(
            row.trusted, row.status, row.hidden, row.warm_session_id,
            row.default_branch, row.color_index, row.url, clean,
          );
          this.db.prepare("DELETE FROM repos WHERE url = ?").run(row.url);
        } else {
          this.db.prepare("UPDATE repos SET url = ? WHERE url = ?").run(clean, row.url);
        }
        cleaned.push({ from: row.url, to: clean });
      }
    });
    tx();
    return cleaned;
  }

  // Hidden repos retain their colors, so include them in usage counts.
  private nextColorIndex(): number {
    const rows = this.db.prepare("SELECT color_index FROM repos").all() as { color_index: number | null }[];
    return pickRepoColorIndex(rows.map((r) => r.color_index).filter(isValidRepoColorIndex));
  }

  setColorIndex(url: string, colorIndex: number): boolean {
    const result = this.db.prepare("UPDATE repos SET color_index = ? WHERE url = ?").run(colorIndex, this.key(url));
    return result.changes > 0;
  }

  setReady(url: string): void {
    this.db.prepare("UPDATE repos SET status = 'ready' WHERE url = ?").run(this.key(url));
  }

  setDefaultBranch(url: string, branch: string): boolean {
    const result = this.db
      .prepare("UPDATE repos SET default_branch = ? WHERE url = ?")
      .run(branch, this.key(url));
    return result.changes > 0;
  }

  setWarmSessionId(url: string, sessionId: string | undefined): void {
    this.db.prepare("UPDATE repos SET warm_session_id = ? WHERE url = ?").run(sessionId ?? null, this.key(url));
  }

  touch(url: string): void {
    this.db.prepare("UPDATE repos SET last_used_at = ? WHERE url = ?").run(new Date().toISOString(), this.key(url));
  }

  remove(url: string): boolean {
    const result = this.db.prepare("DELETE FROM repos WHERE url = ?").run(this.key(url));
    return result.changes > 0;
  }

  list(): RepoInfo[] {
    const rows = this.db.prepare(
      `SELECT * FROM repos
       ORDER BY CASE WHEN display_order IS NULL THEN 1 ELSE 0 END,
                display_order ASC,
                last_used_at DESC,
                rowid DESC`,
    ).all() as RepoRow[];
    return rows.map((r) => this.fromRow(r));
  }

  setOrder(urls: string[]): void {
    const update = this.db.prepare("UPDATE repos SET display_order = ? WHERE url = ?");
    const tx = this.db.transaction((urls: string[]) => {
      for (let i = 0; i < urls.length; i++) {
        update.run(i, this.key(urls[i]));
      }
    });
    tx(urls);
  }

  get(url: string): RepoInfo | undefined {
    const row = this.db.prepare("SELECT * FROM repos WHERE url = ?").get(this.key(url)) as RepoRow | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  isTrusted(url: string): boolean {
    const key = canonicalRepoKey(url);
    const rows = this.db.prepare("SELECT url, trusted FROM repos").all() as Pick<RepoRow, "url" | "trusted">[];
    return rows.some((r) => r.trusted === 1 && canonicalRepoKey(r.url) === key);
  }

  setTrusted(url: string, trusted: boolean): void {
    const key = canonicalRepoKey(url);
    const val = trusted ? 1 : 0;
    const rows = this.db.prepare("SELECT url FROM repos").all() as Pick<RepoRow, "url">[];
    const update = this.db.prepare("UPDATE repos SET trusted = ? WHERE url = ?");
    const tx = this.db.transaction(() => {
      for (const r of rows) {
        if (canonicalRepoKey(r.url) === key) update.run(val, r.url);
      }
    });
    tx();
  }

  // repoId unifies SSH/HTTPS spellings that canonicalRepoKey keeps separate.
  allowsAgentMerge(url: string): boolean {
    const id = repoId(url);
    if (!id) return false;
    const rows = this.db
      .prepare("SELECT url, allow_agent_merge FROM repos")
      .all() as Pick<RepoRow, "url" | "allow_agent_merge">[];
    return rows.some((r) => r.allow_agent_merge === 1 && repoId(r.url) === id);
  }

  setAllowAgentMerge(url: string, allow: boolean): "ok" | "no-identity" | "not-found" {
    const id = repoId(url);
    if (!id) return "no-identity";
    const val = allow ? 1 : 0;
    const rows = this.db.prepare("SELECT url FROM repos").all() as Pick<RepoRow, "url">[];
    const matches = rows.filter((r) => repoId(r.url) === id);
    if (matches.length === 0) return "not-found";
    const update = this.db.prepare("UPDATE repos SET allow_agent_merge = ? WHERE url = ?");
    const tx = this.db.transaction(() => {
      for (const r of matches) update.run(val, r.url);
    });
    tx();
    return "ok";
  }

  setHidden(url: string, hidden: boolean): boolean {
    const result = this.db.prepare("UPDATE repos SET hidden = ? WHERE url = ?").run(hidden ? 1 : 0, this.key(url));
    return result.changes > 0;
  }

  has(url: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM repos WHERE url = ? LIMIT 1").get(this.key(url));
    return row !== undefined;
  }

  clear(): void {
    this.db.prepare("DELETE FROM repos").run();
  }
}
