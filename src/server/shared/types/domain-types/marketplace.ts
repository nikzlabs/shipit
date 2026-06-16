import type { AgentId } from "../agent-types.js";

// ---- Skill types ----

/**
 * A user-invocable skill that can be triggered at the start of a chat message
 * (`/name` on Claude, `$name` on Codex). Feeds the composer's `/` autocomplete
 * menu. See docs/138-skill-invocation.
 */
export interface SkillInfo {
  /** Invocable name, e.g. "my-skill" → `/my-skill` (Claude) or `$my-skill` (Codex). */
  name: string;
  /**
   * On-disk directory name. Usually equal to `name`, but some upstream catalog
   * plugins ship a directory whose frontmatter `name:` doesn't match the
   * folder. Callers that read SKILL.md from disk after a scan should prefer
   * `dirName` (falling back to `name` for older scanner output).
   */
  dirName?: string;
  /** One-line description from the skill's frontmatter, if present. */
  description?: string;
  /**
   * Where the skill comes from. "project" — scanned from the workspace
   * (`.claude/skills/**` or `.codex/skills/**`). "bundled" — a built-in
   * shipped by the active agent backend (e.g. Codex's `~/.codex/skills/**`).
   */
  source: "project" | "bundled";
}

// ---- Marketplace / plugin types (docs/149) ----

/**
 * Where a marketplace catalog is fetched from. v1 only seeds one source
 * (a `github` ref to `anthropics/claude-plugins-official`), but the
 * discriminated union is in place from day one so v2's "add a custom
 * marketplace" verb doesn't need a schema migration.
 */
export type MarketplaceSource =
  | { kind: "github"; ownerRepo: string; ref?: string }
  | { kind: "git";    url: string;      ref?: string }
  | { kind: "local";  path: string }
  | { kind: "url";    url: string };

/** Per-marketplace catalog status, surfaced in the Discover tab. */
export type MarketplaceStatus = "ok" | "fetch-failed" | "loading";

/**
 * Metadata about a single catalog (e.g. `claude-plugins-official`). Lives in
 * `marketplaces` SQLite table; v1 ships with one row pre-seeded.
 */
export interface MarketplaceInfo {
  id: string;
  source: MarketplaceSource;
  agentId: AgentId;
  autoUpdate: boolean;
  status: MarketplaceStatus;
  lastFetchedAt?: string;
  /** When set, the catalog clone failed and this is the surfaced error. */
  fetchError?: string;
}

/** A skill bundled inside a plugin. v3 adds richer ref types alongside this. */
export interface SkillRef {
  /**
   * Invocable name from the SKILL.md frontmatter `name:` field. This is what
   * the user types after `/` (Claude) or `$` (Codex) and what's preserved in
   * the install target's frontmatter as `<plugin>:<name>`.
   */
  name: string;
  /**
   * On-disk directory name inside the source plugin's `skills/` folder.
   * Usually equal to `name`, but upstream catalogs sometimes ship a directory
   * whose frontmatter `name:` doesn't match (e.g. `skills/writing-rules/`
   * with `name: writing-hookify-rules`). Used for source path lookups when
   * reading SKILL.md from the marketplace cache; `name` is used everywhere
   * user-facing.
   */
  dirName?: string;
  /** First line of the SKILL.md frontmatter `description`, if present. */
  description?: string;
}

/**
 * A plugin entry parsed from a marketplace's `marketplace.json`. v1 only
 * surfaces plugins whose source is an in-repo relative path AND that contain
 * at least one `skills/<name>/SKILL.md` — those are installable as a simple
 * file copy without secondary fetches. External plugins and plugins without
 * skills are filtered out for v1 (deferred to v2/v3 — see docs/149 plan).
 */
export interface PluginInfo {
  marketplaceId: string;
  name: string;
  description?: string;
  author?: string;
  category?: string;
  homepage?: string;
  /** Skills the plugin will install into `<agent skills dir>/skills/<plugin>__<skill>/`. */
  skills: SkillRef[];
  /** Rough sum of skill `SKILL.md` byte sizes — the v1 "context cost" proxy. */
  estimatedContextBytes: number;
  /** Optional commit SHA the catalog pins this plugin to (for v3 diffs). */
  pinnedSha?: string;
  /** ISO timestamp of the catalog's last update (used in cards if present). */
  lastUpdated?: string;
}

/**
 * Recorded next to every ShipIt-managed skill directory as
 * `.shipit-installed.json`. Used to differentiate ShipIt-installed skills
 * from hand-written ones (collision detection, safe uninstall, upgrade hash
 * check). Hand-written skills have no marker and are off-limits to the
 * install flow.
 */
export interface InstallMarker {
  marketplaceId: string;
  pluginName: string;
  /** Catalog's pinned SHA at install time, or `"head"` when none was pinned. */
  version: string;
  installedAt: string;
  /** sha256 of `SKILL.md` at install time. Upgrade refuses if it diverged. */
  skillMdHash: string;
}

/** Returned from `installPlugin()` so the client can refresh + report status. */
export interface InstallResult {
  /** The directories written under the active agent's project skills dir (one per skill). */
  installedDirs: string[];
  /** Auto-commit hash. `null` when nothing was committed (e.g. no-op upgrade). */
  commitHash: string | null;
  /** Token convention for the install confirmation toast. */
  invocationTokens: string[];
}
