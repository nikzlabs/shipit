/**
 * EgressAllowlistStore — durable egress allowlist + containment toggle (SQLite).
 *
 * docs/172-agent-containment Gap 1 (SHI-90). The Tier A/B/C egress enforcement
 * (egress-firewall / egress-dns / egress-proxy) reads its allowlist from the
 * built-in base list + `SESSION_EGRESS_ALLOWLIST` + the live MCP credential
 * store, and its allow-once decisions were per-session **in-memory** (see
 * `egress-policy.ts`). This store is the durable layer the Settings UI writes:
 *
 *   - **Allowlist** (`egress_allowlist`): user-added hosts keyed by scope —
 *     `'global'` for the Settings allowlist editor (applies to every session),
 *     or a **session id** for a per-session extra ("let this one session also
 *     reach X"). The Tier C card's "Add to allowlist" writes a `global` host
 *     here so the grant outlives the session.
 *   - **Containment toggle** (`egress_settings`): the default-on global switch
 *     (Contained vs Open) keyed by `'global'`, plus an optional per-session
 *     **override** keyed by the session id. Absence resolves fail-secure:
 *     a missing global row → Contained; a missing session row → inherit global.
 *
 * Follows the `SecretStore`/`RepoStore` pattern: SQLite via `DatabaseManager`,
 * a class wrapping prepared statements. Pure persistence — composition into the
 * resolver/proxy config lives in `egress-allowlist.ts`; gating lives in
 * `container-lifecycle.ts`.
 */

import type { DatabaseManager } from "../shared/database.js";
import { normalizeHost, EGRESS_DEFAULT_ALLOWLIST } from "./egress-allowlist.js";

/** The reserved scope key for the global (all-session) allowlist + toggle. */
export const EGRESS_GLOBAL_SCOPE = "global";

/**
 * Reserved scope key holding the **suppressed built-in defaults** — entries from
 * {@link EGRESS_DEFAULT_ALLOWLIST} the user has removed via the Settings editor.
 * The built-in list is a *default*, not a hard floor: removing one records it
 * here, and "Restore defaults" clears the scope. The `__` sentinel can't collide
 * with a session id (uuids) or the literal `global`.
 */
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

  // --- Allowlist hosts -----------------------------------------------------

  /** List the user-added hosts for a scope (`'global'` or a session id). */
  listHosts(scope: string): string[] {
    // Insertion order (rowid) — stable + intuitive for the editor list, and
    // immune to `created_at` collisions within the same millisecond.
    const rows = this.db
      .prepare("SELECT host FROM egress_allowlist WHERE scope = ? ORDER BY rowid ASC")
      .all(scope) as HostRow[];
    return rows.map((r) => r.host);
  }

  /**
   * Add a host to a scope. Normalized (lowercase, no trailing dot) so the
   * stored value matches what the matcher (`hostMatchesEntry`) compares. A
   * leading "." is preserved (suffix match). Idempotent — re-adding is a no-op.
   * Returns true if a new row was inserted (false if it already existed or the
   * host was blank).
   */
  addHost(scope: string, host: string): boolean {
    const h = normalizeEntry(host);
    if (!h) return false;
    const res = this.db
      .prepare("INSERT OR IGNORE INTO egress_allowlist (scope, host, created_at) VALUES (?, ?, ?)")
      .run(scope, h, new Date().toISOString());
    return res.changes > 0;
  }

  /** Remove a host from a scope. Returns true if a row was deleted. */
  removeHost(scope: string, host: string): boolean {
    const h = normalizeEntry(host);
    if (!h) return false;
    const res = this.db.prepare("DELETE FROM egress_allowlist WHERE scope = ? AND host = ?").run(scope, h);
    return res.changes > 0;
  }

  /**
   * The effective extra hosts for a session: the global allowlist plus that
   * session's own extras, de-duplicated. Fed into the resolver/proxy allowlist
   * composition (`egress-allowlist.ts`).
   */
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

  // --- Built-in defaults (overridable) ------------------------------------

  /** The built-in defaults the user has removed (suppressed). */
  listSuppressedDefaults(): string[] {
    return this.listHosts(EGRESS_SUPPRESSED_SCOPE);
  }

  /** Is this built-in default currently suppressed (removed by the user)? */
  isDefaultSuppressed(host: string): boolean {
    const h = normalizeEntry(host);
    return !!h && this.listSuppressedDefaults().includes(h);
  }

  /** Remove a built-in default — record it as suppressed. Returns true if newly suppressed. */
  suppressDefault(host: string): boolean {
    return this.addHost(EGRESS_SUPPRESSED_SCOPE, host);
  }

  /** Re-enable a previously-removed built-in default. Returns true if it was suppressed. */
  unsuppressDefault(host: string): boolean {
    return this.removeHost(EGRESS_SUPPRESSED_SCOPE, host);
  }

  /** Whether the user has removed any built-in default (drives "Restore defaults"). */
  hasSuppressedDefaults(): boolean {
    return this.listSuppressedDefaults().length > 0;
  }

  /** Restore all built-in defaults (clear every suppression). */
  restoreDefaults(): void {
    this.db.prepare("DELETE FROM egress_allowlist WHERE scope = ?").run(EGRESS_SUPPRESSED_SCOPE);
  }

  /**
   * The effective built-in base: {@link EGRESS_DEFAULT_ALLOWLIST} minus the
   * defaults the user has suppressed. Fed into the resolver/proxy config so a
   * removed default is actually closed at the next container start.
   */
  effectiveBase(): string[] {
    const suppressed = new Set(this.listSuppressedDefaults());
    return EGRESS_DEFAULT_ALLOWLIST.filter((h) => !suppressed.has(normalizeHost(h)));
  }

  // --- Containment toggle --------------------------------------------------

  /**
   * The global containment switch. Default **true** (Contained) when no row
   * exists — fail-secure, so an unreadable/missing setting never silently opens
   * egress.
   */
  getGlobalEnabled(): boolean {
    const row = this.db
      .prepare("SELECT enabled FROM egress_settings WHERE scope = ?")
      .get(EGRESS_GLOBAL_SCOPE) as SettingRow | undefined;
    return row ? row.enabled === 1 : true;
  }

  /** Set the global containment switch (true = Contained, false = Open). */
  setGlobalEnabled(enabled: boolean): void {
    this.db
      .prepare(
        "INSERT INTO egress_settings (scope, enabled) VALUES (?, ?) " +
          "ON CONFLICT(scope) DO UPDATE SET enabled = excluded.enabled",
      )
      .run(EGRESS_GLOBAL_SCOPE, enabled ? 1 : 0);
  }

  /**
   * A session's containment override: `true` = force Contained, `false` =
   * force Open, `null` = inherit the global switch (no row).
   */
  getSessionOverride(sessionId: string): boolean | null {
    const row = this.db
      .prepare("SELECT enabled FROM egress_settings WHERE scope = ?")
      .get(sessionId) as SettingRow | undefined;
    if (!row) return null;
    return row.enabled === 1;
  }

  /** Set or clear a session's containment override (`null` clears it). */
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

  /**
   * Resolve whether a session should be **contained**: its override if set,
   * else the global switch. Default Contained (fail-secure).
   */
  resolveContained(sessionId: string): boolean {
    const override = this.getSessionOverride(sessionId);
    if (override !== null) return override;
    return this.getGlobalEnabled();
  }

  /** Drop a session's per-session allowlist + override (call on dispose). */
  clearSession(sessionId: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM egress_allowlist WHERE scope = ?").run(sessionId);
      this.db.prepare("DELETE FROM egress_settings WHERE scope = ?").run(sessionId);
    });
    tx();
  }
}

/**
 * Normalize an allowlist entry for storage. Lowercases + strips a trailing dot
 * via {@link normalizeHost}, preserving a leading "." (suffix match). Blank →
 * "" (rejected by callers).
 */
function normalizeEntry(host: string): string {
  const trimmed = host.trim();
  if (!trimmed) return "";
  // normalizeHost strips a trailing dot + lowercases; it leaves a leading "."
  // intact, which is the suffix-match marker the matcher relies on.
  return normalizeHost(trimmed);
}
