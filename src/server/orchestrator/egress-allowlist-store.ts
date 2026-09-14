import type { DatabaseManager } from "../shared/database.js";
import { normalizeHost, EGRESS_DEFAULT_ALLOWLIST } from "./egress-allowlist.js";

export const EGRESS_GLOBAL_SCOPE = "global";
export const EGRESS_SUPPRESSED_SCOPE = "__suppressed_defaults__";

interface HostRow {
  host: string;
}

interface SettingRow {
  enabled: number;
}

export class EgressAllowlistStore {
  private db;

  constructor(dbManager: DatabaseManager) {
    this.db = dbManager.db;
  }

  listHosts(scope: string): string[] {
    const rows = this.db
      .prepare("SELECT host FROM egress_allowlist WHERE scope = ? ORDER BY rowid ASC")
      .all(scope) as HostRow[];
    return rows.map((r) => r.host);
  }

  addHost(scope: string, host: string): boolean {
    const h = normalizeEntry(host);
    if (!h) return false;
    const res = this.db
      .prepare("INSERT OR IGNORE INTO egress_allowlist (scope, host, created_at) VALUES (?, ?, ?)")
      .run(scope, h, new Date().toISOString());
    return res.changes > 0;
  }

  /**
   * Matches on the NORMALIZED row, not on the stored string. A row written
   * before `normalizeHost` stripped every trailing dot is stored as `a.test.`
   * while every reader — the settings read included — normalizes it again and
   * shows `a.test`, so an exact SQL match would leave the row behind and report
   * that the address named nothing (docs/299-agent-settings-access req 1). Rows
   * that normalize alike are the same host, so removing all of them is right.
   */
  removeHost(scope: string, host: string): boolean {
    const h = normalizeEntry(host);
    if (!h) return false;
    const stored = this.listHosts(scope).filter((row) => normalizeHost(row) === h);
    if (stored.length === 0) return false;
    const del = this.db.prepare("DELETE FROM egress_allowlist WHERE scope = ? AND host = ?");
    let removed = 0;
    for (const row of stored) removed += del.run(scope, row).changes;
    return removed > 0;
  }

  effectiveHosts(sessionId: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const h of [...this.listHosts(EGRESS_GLOBAL_SCOPE), ...this.listHosts(sessionId)]) {
      if (seen.has(h)) continue;
      seen.add(h);
      out.push(h);
    }
    return out;
  }

  listSuppressedDefaults(): string[] {
    return this.listHosts(EGRESS_SUPPRESSED_SCOPE);
  }

  isDefaultSuppressed(host: string): boolean {
    const h = normalizeEntry(host);
    return !!h && this.listSuppressedDefaults().includes(h);
  }

  suppressDefault(host: string): boolean {
    return this.addHost(EGRESS_SUPPRESSED_SCOPE, host);
  }

  unsuppressDefault(host: string): boolean {
    return this.removeHost(EGRESS_SUPPRESSED_SCOPE, host);
  }

  hasSuppressedDefaults(): boolean {
    return this.listSuppressedDefaults().length > 0;
  }

  restoreDefaults(): void {
    this.db.prepare("DELETE FROM egress_allowlist WHERE scope = ?").run(EGRESS_SUPPRESSED_SCOPE);
  }

  effectiveBase(): string[] {
    const suppressed = new Set(this.listSuppressedDefaults());
    return EGRESS_DEFAULT_ALLOWLIST.filter((h) => !suppressed.has(normalizeHost(h)));
  }

  getGlobalEnabled(): boolean {
    const row = this.db
      .prepare("SELECT enabled FROM egress_settings WHERE scope = ?")
      .get(EGRESS_GLOBAL_SCOPE) as SettingRow | undefined;
    return row ? row.enabled === 1 : true;
  }

  setGlobalEnabled(enabled: boolean): void {
    this.db
      .prepare(
        "INSERT INTO egress_settings (scope, enabled) VALUES (?, ?) " +
          "ON CONFLICT(scope) DO UPDATE SET enabled = excluded.enabled",
      )
      .run(EGRESS_GLOBAL_SCOPE, enabled ? 1 : 0);
  }

  /** true: contained; false: open; null: inherit global. */
  getSessionOverride(sessionId: string): boolean | null {
    const row = this.db
      .prepare("SELECT enabled FROM egress_settings WHERE scope = ?")
      .get(sessionId) as SettingRow | undefined;
    if (!row) return null;
    return row.enabled === 1;
  }

  setSessionOverride(sessionId: string, override: boolean | null): void {
    if (override === null) {
      this.db.prepare("DELETE FROM egress_settings WHERE scope = ?").run(sessionId);
      return;
    }
    this.db
      .prepare(
        "INSERT INTO egress_settings (scope, enabled) VALUES (?, ?) " +
          "ON CONFLICT(scope) DO UPDATE SET enabled = excluded.enabled",
      )
      .run(sessionId, override ? 1 : 0);
  }

  resolveContained(sessionId: string): boolean {
    const override = this.getSessionOverride(sessionId);
    if (override !== null) return override;
    return this.getGlobalEnabled();
  }

  clearSession(sessionId: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM egress_allowlist WHERE scope = ?").run(sessionId);
      this.db.prepare("DELETE FROM egress_settings WHERE scope = ?").run(sessionId);
    });
    tx();
  }
}

function normalizeEntry(host: string): string {
  const trimmed = host.trim();
  if (!trimmed) return "";
  return normalizeHost(trimmed);
}
