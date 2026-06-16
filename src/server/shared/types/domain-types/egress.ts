// ---- Egress settings (docs/172 / SHI-90) ----

/**
 * Global egress containment settings surfaced to the browser Settings panel.
 * `globalEnabled` is the default-on containment switch (true = Contained =
 * default-deny + allowlist + prompts; false = Open = unrestricted egress).
 * `globalHosts` is the user-managed allowlist (in addition to the built-in base
 * list, operator extras, and live MCP hosts).
 */
export interface EgressSettings {
  globalEnabled: boolean;
  globalHosts: string[];
}

/**
 * A session's egress view: the resolved containment plus its own override and
 * per-session extra hosts. `override` is `null` when the session inherits the
 * global switch, `true`/`false` when it forces Contained/Open.
 */
export interface EgressSessionSettings {
  sessionId: string;
  override: boolean | null;
  hosts: string[];
  /** Resolved containment after applying override over global. */
  effectiveContained: boolean;
  /** The current global switch, for rendering the "inherits global" state. */
  globalEnabled: boolean;
}

/**
 * Where an effective-allowlist entry comes from. Only the two `user-*` sources
 * are user-editable; the rest are derived and shown read-only so the editor can
 * explain *why* a host is reachable.
 *   - `builtin`      — the always-on base list (agent APIs, git host, registries).
 *   - `operator`     — the deployment's `SESSION_EGRESS_ALLOWLIST` env.
 *   - `mcp`          — a connected MCP server / OAuth provider host.
 *   - `user-global`  — added by the user via the Settings allowlist editor.
 *   - `user-session` — added by the user for one session (per-session override).
 */
export type EgressAllowlistSource = "builtin" | "operator" | "mcp" | "user-global" | "user-session";

/** One row of the effective allowlist, with provenance + whether it's removable. */
export interface EgressAllowlistEntry {
  host: string;
  source: EgressAllowlistSource;
  /** True only for `user-global` / `user-session` — built-ins/MCP/operator are read-only. */
  removable: boolean;
}

/**
 * The full effective-allowlist view for the Settings editor: every host the
 * session can reach (with provenance), the global containment toggle, and — when
 * a session is in scope — that session's override + resolved containment.
 */
export interface EgressAllowlistView {
  entries: EgressAllowlistEntry[];
  globalEnabled: boolean;
  /** The in-scope session's settings, or null for the global-only view. */
  session: EgressSessionSettings | null;
  /** True when the user has removed any built-in default (drives "Restore defaults"). */
  defaultsCustomized: boolean;
}
