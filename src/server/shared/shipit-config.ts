/**
 * Unified shipit.yaml parser — reads `version`, `agent`, `compose`, `release`,
 * and `issues` blocks.
 *
 *   version: 1          # optional schema version
 *   agent:              # optional agent container config
 *     install:
 *       - npm install
 *       - npx prisma generate
 *     dep-dirs:         # dependency dirs eligible for the overlay store (docs/183)
 *       - node_modules
 *   compose: docker-compose.yml   # string or object form
 *   issues:             # additional issue trackers, as Issues tabs (docs/247)
 *     trackers:
 *       - kind: github
 *         repo: owner/planning
 *
 * Old-format keys (preview, resources, capabilities, services) emit warnings
 * with migration hints. The `agent.memory` / `agent.cpu` / `agent.pids`
 * resource fields were removed (docs/229): session sizing is now automatic
 * (derived from host capacity), so a shipit.yaml that still sets them is
 * warned-and-ignored rather than honored.
 */

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { ReleaseMechanism } from "./types/release-types.js";
import { defaultTrackerLabel, parseOwnerRepo } from "./tracker-id.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentConfig {
  /** Install commands, run sequentially before compose starts. Default: [] */
  install: string[];
  /**
   * Dependency directories eligible for the overlay dep store (docs/183),
   * declared as **literal relative paths** (no globs) inside the workspace.
   * Default: `["node_modules"]`. Structurally-invalid entries (absolute, glob,
   * `..`-escaping, the workspace root) are dropped with a warning rather than
   * failing the session. Whether each surviving path actually exists as a
   * dependency dir (and isn't tracked source) is a contextual check applied by
   * the overlay-spec builder against the host clone (docs/183 Phase 2), not here.
   */
  depDirs: string[];
  /**
   * Explicit dependency-input files for the content-keyed install skip
   * (`deps-hash.ts`, docs/197), declared as **literal relative paths** (no
   * globs). `null` when `agent.install-inputs` is absent — the marker then
   * derives its hashed inputs from the install commands (and stays commit-only
   * if any command isn't a recognized pure dependency install). When set
   * (including an explicit empty list) it **replaces** that default set, opting
   * the repo into content-keying regardless of the install commands. Same
   * structural validation as `depDirs`: invalid entries are dropped with a warning.
   */
  installInputs: string[] | null;
}

export interface ComposeConfig {
  /** Path to compose file (relative to workspace root). */
  file: string;
  /** Grant Docker socket access to compose services. Default: false */
  dockerSocket: boolean;
}

/** Allowed version-source identifiers for the `release:` block (docs/171 Phase 2). */
export type ReleaseVersionSource = "package.json" | "Cargo.toml" | "pyproject.toml" | "VERSION" | "tag";

/**
 * Release mechanism — defined in `types/release-types.ts` (it rides on the
 * release card through the shared types barrel) and re-exported here so the
 * `release:` config parser keeps a single source of truth:
 * - `tag-triggered` (option a) — the agent pushes a `vX.Y.Z` tag and the repo's
 *   own `on: push: tags` workflow gates + publishes.
 * - `brokered` (option b, Phase 4) — orchestrator-brokered Release creation.
 * - `release-branch` (docs/214) — a release is cut by merging a version-bump PR
 *   into a long-lived maintenance branch; CI derives the tag from the version
 *   source on the merged commit, gates, tags, and publishes. Requires a non-tag
 *   version source (a branch push has no tag to read the version from).
 */
export type { ReleaseMechanism } from "./types/release-types.js";

/**
 * Optional `release:` block in shipit.yaml — overrides auto-detection for
 * multi-ecosystem repos (docs/171 Phase 2). All fields are optional; absent
 * fields fall back to auto-detection or documented defaults.
 */
export interface ReleaseConfig {
  /** Which file holds the authoritative version. Auto-detected when absent. */
  versionSource?: ReleaseVersionSource;
  /**
   * Path (relative to the repo root) to the file holding the authoritative
   * version, for monorepos where the version source isn't at the root (docs/214).
   * **Augments** `versionSource`: `versionSource` says *how* to parse (which
   * ecosystem), `versionSourcePath` says *where* (e.g.
   * `packages/api/package.json`). Absent → the version source is at the root.
   */
  versionSourcePath?: string;
  /**
   * The long-lived maintenance branch a `release-branch` release is cut from by
   * merging a version-bump PR into it (docs/214). Default: `"stable"`. Only
   * meaningful when `mechanism` is `"release-branch"`.
   */
  branch?: string;
  /** Tag name pattern. Must contain `{version}`. Default: `"v{version}"`. */
  tagPattern?: string;
  /** Tag pattern for release candidates. Default: `"v{version}-rc.{n}"`. */
  prereleasePattern?: string;
  /**
   * How release notes are sourced. One of: `"github-generated"` (default),
   * `"commits"`, or `"changelog:<path>"` (e.g. `"changelog:CHANGELOG.md"`).
   */
  notes?: string;
  /** Optional local gate command the agent runs before tagging (e.g. `"npm test"`). */
  gate?: string;
  /** Release mechanism. Default: `"tag-triggered"`. */
  mechanism?: ReleaseMechanism;
  /** Path to the release workflow file (for existence checks and scaffolding). */
  workflow?: string;
}

/**
 * docs/128 — a single allow-listed read-only host path mounted into the agent
 * container. Only used by privileged "ops" sessions; the container-creation
 * gate additionally requires the session's server-side `kind === "ops"`, so a
 * forged `x-shipit-host-mounts` in an ordinary session's shipit.yaml has its
 * mounts dropped.
 */
export interface HostMount {
  /** Host path (must be one of the allow-listed sources). */
  source: string;
  /** Container path (fixed mapping; equal to the source for the journal/socket paths). */
  target: string;
  /** Always read-only — host mounts are never writable from the agent. */
  readOnly: true;
}

/**
 * docs/247 — one entry of the `issues.trackers` list: an additional issue
 * tracker the repository declares, rendered as its own tab in the Issues UI.
 *
 * A **tagged union discriminated on `kind`** (the discriminator name the issue
 * domain types already use for `IssueWriteUndo`), not a bare list of
 * repositories. The identifying fields belong to the kind — `repo` is GitHub's —
 * so a tracker identified by something other than an `owner/repo` can be added
 * later without reshaping the block or migrating existing configs. This feature
 * defines only `github`.
 */
export interface DeclaredGitHubTracker {
  kind: "github";
  owner: string;
  repo: string;
  /** Sub-tab label. Defaults to the repository name when `label` is absent. */
  label: string;
}

/** docs/247 — a declared additional tracker. Only `github` is defined today. */
export type DeclaredTracker = DeclaredGitHubTracker;

/** docs/247 — the optional `issues:` block. */
export interface IssuesConfig {
  /** Declared additional trackers, in declaration order (drives tab order). */
  trackers: DeclaredTracker[];
}

export interface ShipitConfig {
  /** Schema version. Currently 1. */
  version?: number;
  /** Agent container configuration. */
  agent: AgentConfig;
  /** Compose file configuration. Undefined if no compose path specified or detected. */
  compose?: ComposeConfig;
  /**
   * docs/128 — allow-listed read-only host mounts (`x-shipit-host-mounts`).
   * Empty for ordinary sessions. Even when populated, mounts are only applied
   * to the agent container when the session's server-side `kind === "ops"`.
   */
  hostMounts: HostMount[];
  /** Optional release configuration block (docs/171 Phase 2). */
  release?: ReleaseConfig;
  /**
   * docs/247 — additional issue trackers this repository declares. Always
   * present (empty when the `issues:` block is absent) so callers never have to
   * branch on undefined to get the common "no declarations" case.
   */
  issues: IssuesConfig;
  /** Warnings emitted during parsing (unknown keys, migration hints). */
  warnings: string[];
}

export class ShipitConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShipitConfigError";
  }
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default dep dirs eligible for the overlay store when `agent.dep-dirs` is absent (docs/183). */
export const DEFAULT_DEP_DIRS: readonly string[] = ["node_modules"];

export const AGENT_DEFAULTS: Readonly<AgentConfig> = {
  install: [],
  depDirs: [...DEFAULT_DEP_DIRS],
  installInputs: null,
};

// ---------------------------------------------------------------------------
// Known keys for validation
// ---------------------------------------------------------------------------

const KNOWN_TOP_LEVEL_KEYS = new Set([
  "version",
  "agent",
  "compose",
  "release",
  "issues",
  "x-shipit-host-mounts",
]);
const KNOWN_AGENT_KEYS = new Set(["install", "dep-dirs", "install-inputs"]);

/**
 * Removed `agent.*` resource keys (docs/229). Session sizing is now derived
 * automatically from host capacity, so these are warned-and-ignored rather
 * than reported as generic unknown keys.
 */
const DEPRECATED_AGENT_KEYS: Record<string, string> = {
  memory:
    "`agent.memory` is no longer used — session memory is sized automatically from host capacity (docs/229). Set the deployment env `DEFAULT_SESSION_MEMORY_MB` / `MAX_SESSION_MEMORY_MB` to override.",
  cpu: "`agent.cpu` is no longer used — CPU is no longer a per-repo limit (docs/229).",
  pids: "`agent.pids` is no longer used — the per-session process ceiling is fixed (docs/229).",
};

/**
 * docs/128 — the only host paths an ops session may bind-mount (read-only) into
 * the agent container. Maps host source → container target. Anything outside
 * this map is rejected by the parser. `/var/run/docker.sock` is listed for
 * completeness, but in practice the agent reaches Docker via the read-only
 * proxy over `DOCKER_HOST`, not by mounting the socket — the real socket is
 * mounted only into the docker-socket-proxy sibling (a compose service).
 */
export const ALLOWED_HOST_MOUNT_SOURCES: Readonly<Record<string, string>> = {
  "/var/run/docker.sock": "/var/run/docker.sock",
  "/var/log/journal": "/var/log/journal",
  "/run/log/journal": "/run/log/journal",
};

/** Old-format keys that trigger migration warnings. */
const OLD_FORMAT_KEYS: Record<string, string> = {
  preview: "The `preview` block has been removed. Define services in docker-compose.yml instead. See /shipit-docs/compose.md.",
  resources: "The `resources` block has been removed. Session sizing is automatic (docs/229); preview resources are set per-service in docker-compose.yml.",
  capabilities: "The `capabilities` block has been replaced. Use `compose.docker-socket: true` instead of `capabilities.docker: true`.",
  services: "The `services` block has been removed. Define services in docker-compose.yml instead.",
  install: "The top-level `install` field has moved to `agent.install`.",
};

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a shipit.yaml document object into a ShipitConfig.
 * Exported for testing — callers should use `resolveShipitConfig()`.
 */
export function parseShipitConfig(doc: unknown): ShipitConfig {
  const warnings: string[] = [];

  if (doc === null || doc === undefined) {
    return { agent: { ...AGENT_DEFAULTS, install: [] }, hostMounts: [], issues: { trackers: [] }, warnings };
  }

  if (typeof doc !== "object" || Array.isArray(doc)) {
    throw new ShipitConfigError("shipit.yaml must be a YAML mapping (object)");
  }

  const raw = doc as Record<string, unknown>;

  // Check for old-format keys
  for (const [key, hint] of Object.entries(OLD_FORMAT_KEYS)) {
    if (key in raw) {
      warnings.push(hint);
    }
  }

  // Check for unknown top-level keys (excluding old-format keys which already warned)
  for (const key of Object.keys(raw)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key) && !(key in OLD_FORMAT_KEYS)) {
      warnings.push(`Unknown top-level key \`${key}\` in shipit.yaml.`);
    }
  }

  // ---- version ----
  let version: number | undefined;
  if ("version" in raw) {
    if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1) {
      throw new ShipitConfigError("`version` must be a positive integer");
    }
    version = raw.version;
  }

  // ---- agent ----
  const agent = parseAgentConfig(raw.agent, warnings);

  // ---- compose ----
  const compose = parseComposeConfig(raw.compose);

  // ---- release (docs/171) ----
  const release = parseReleaseConfig(raw.release, warnings);

  // ---- issues (docs/247) ----
  const issues = parseIssuesConfig(raw.issues, warnings);

  // ---- x-shipit-host-mounts (docs/128) ----
  const hostMounts = parseHostMounts(raw["x-shipit-host-mounts"]);

  return { version, agent, compose, release, issues, hostMounts, warnings };
}

const KNOWN_ISSUES_KEYS = new Set(["trackers"]);
const KNOWN_GITHUB_TRACKER_KEYS = new Set(["kind", "repo", "label"]);

/**
 * docs/247 — parse the `issues:` block.
 *
 * ```yaml
 * issues:
 *   trackers:
 *     - kind: github           # which tracker backs this tab
 *       repo: owner/planning   # GitHub Issues: `owner/name`
 *       label: Planning        # optional; defaults to the repository name
 * ```
 *
 * **Nothing here is fatal.** Every malformed shape — a non-list `trackers`, a
 * non-mapping entry, a `github` entry with a missing or unparseable `repo`, and
 * an entry whose `kind` this version does not recognize — warns and skips that
 * entry rather than throwing. That is the forward-compatibility path req 5
 * requires: a `shipit.yaml` written against a newer ShipIt that declares a
 * tracker kind this build has never heard of must degrade to "that tab doesn't
 * appear", not "the session fails to start". The other blocks throw on bad
 * input because they gate the container; a tracker declaration gates one tab.
 */
function parseIssuesConfig(raw: unknown, warnings: string[]): IssuesConfig {
  if (raw === undefined || raw === null) return { trackers: [] };

  if (typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push("`issues` must be a mapping (object); ignoring it.");
    return { trackers: [] };
  }

  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!KNOWN_ISSUES_KEYS.has(key)) {
      warnings.push(`Unknown key \`issues.${key}\` in shipit.yaml.`);
    }
  }

  const rawTrackers = obj.trackers;
  if (rawTrackers === undefined || rawTrackers === null) return { trackers: [] };
  if (!Array.isArray(rawTrackers)) {
    warnings.push("`issues.trackers` must be a list; ignoring it.");
    return { trackers: [] };
  }

  const trackers: DeclaredTracker[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rawTrackers.length; i++) {
    const entry = parseDeclaredTracker(rawTrackers[i], i, warnings);
    if (!entry) continue;
    // De-duplicate on the tracker's identity, so a repeated declaration doesn't
    // mint two tabs with the same id (which would make `get()` ambiguous).
    const key = `${entry.kind}:${entry.owner}/${entry.repo}`.toLowerCase();
    if (seen.has(key)) {
      warnings.push(`Ignoring \`issues.trackers[${i}]\`: duplicate declaration of \`${entry.owner}/${entry.repo}\`.`);
      continue;
    }
    seen.add(key);
    trackers.push(entry);
  }
  return { trackers };
}

/** Parse one `issues.trackers` entry; returns null (and warns) when unusable. */
function parseDeclaredTracker(entry: unknown, index: number, warnings: string[]): DeclaredTracker | null {
  const drop = (reason: string): null => {
    warnings.push(`Ignoring \`issues.trackers[${index}]\`: ${reason}.`);
    return null;
  };

  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return drop("each entry must be a mapping with a `kind`");
  }
  const obj = entry as Record<string, unknown>;
  const kind = obj.kind;
  if (typeof kind !== "string" || !kind.trim()) {
    return drop("each entry must state its tracker `kind` (e.g. `kind: github`)");
  }

  if (kind.trim().toLowerCase() !== "github") {
    // Forward compatibility: a kind from a newer ShipIt, not a user error.
    return drop(`unrecognized tracker \`kind: ${kind}\` — this version of ShipIt only supports \`github\``);
  }

  for (const key of Object.keys(obj)) {
    if (!KNOWN_GITHUB_TRACKER_KEYS.has(key)) {
      warnings.push(`Unknown key \`issues.trackers[${index}].${key}\` in shipit.yaml.`);
    }
  }

  const repoSlug = obj.repo;
  if (typeof repoSlug !== "string" || !repoSlug.trim()) {
    return drop("a `github` tracker needs `repo: owner/name`");
  }
  const ref = parseOwnerRepo(repoSlug);
  if (!ref) {
    return drop(`\`repo: ${repoSlug}\` must be an \`owner/name\` slug`);
  }

  const rawLabel = obj.label;
  if (rawLabel !== undefined && (typeof rawLabel !== "string" || !rawLabel.trim())) {
    warnings.push(
      `Ignoring \`issues.trackers[${index}].label\`: must be a non-empty string; using the repository name.`,
    );
  }
  const label =
    typeof rawLabel === "string" && rawLabel.trim() ? rawLabel.trim() : defaultTrackerLabel(ref);

  return { kind: "github", owner: ref.owner, repo: ref.repo, label };
}

/**
 * docs/128 — parse `x-shipit-host-mounts`: a list of host source paths to bind
 * read-only into the agent container. Each entry must be one of the allow-listed
 * sources (`ALLOWED_HOST_MOUNT_SOURCES`); anything else throws. Duplicates are
 * de-duplicated. Returns [] when the key is absent.
 *
 * Note: this only describes intent. Whether the mounts are actually applied is
 * decided at container-creation time and gated on the session's server-side
 * `kind === "ops"` — a forged entry on an ordinary session is dropped there.
 */
function parseHostMounts(raw: unknown): HostMount[] {
  if (raw === undefined || raw === null) return [];

  if (!Array.isArray(raw)) {
    throw new ShipitConfigError("`x-shipit-host-mounts` must be a list of host paths");
  }

  const seen = new Set<string>();
  const mounts: HostMount[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry: unknown = raw[i];
    if (typeof entry !== "string") {
      throw new ShipitConfigError(`\`x-shipit-host-mounts[${i}]\` must be a string host path`);
    }
    const source = entry.trim();
    const target = ALLOWED_HOST_MOUNT_SOURCES[source];
    if (!target) {
      const allowed = Object.keys(ALLOWED_HOST_MOUNT_SOURCES).join(", ");
      throw new ShipitConfigError(
        `\`x-shipit-host-mounts[${i}]\`: host mount \`${source}\` is not allowed. Allowed: ${allowed}`,
      );
    }
    if (seen.has(source)) continue;
    seen.add(source);
    mounts.push({ source, target, readOnly: true });
  }
  return mounts;
}

function parseAgentConfig(raw: unknown, warnings: string[]): AgentConfig {
  if (raw === undefined || raw === null) {
    return { ...AGENT_DEFAULTS, install: [] };
  }

  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ShipitConfigError("`agent` must be a mapping (object)");
  }

  const obj = raw as Record<string, unknown>;

  // Removed resource keys get a specific migration warning; anything else
  // unrecognized gets the generic unknown-key warning.
  for (const key of Object.keys(obj)) {
    if (key in DEPRECATED_AGENT_KEYS) {
      warnings.push(DEPRECATED_AGENT_KEYS[key]);
    } else if (!KNOWN_AGENT_KEYS.has(key)) {
      warnings.push(`Unknown key \`agent.${key}\` in shipit.yaml.`);
    }
  }

  const install = parseInstallList(obj.install);
  const depDirs = parseDepDirs(obj["dep-dirs"], warnings);
  const installInputs = parseInstallInputs(obj["install-inputs"], warnings);

  return { install, depDirs, installInputs };
}

/** Glob metacharacters — `agent.dep-dirs` accepts literal paths only (docs/183). */
const DEP_DIR_GLOB_CHARS = /[*?[\]{}]/;

/**
 * Parse `agent.dep-dirs` (docs/183) into a list of normalized, literal relative
 * dep-dir paths. Structural validation only — the parser has no workspace/git
 * context, so "exists as a dependency dir and isn't tracked source" is deferred
 * to the overlay-spec builder (Phase 2).
 *
 * Semantics:
 * - absent/null → the default `["node_modules"]`.
 * - a bare string is treated as a one-element list.
 * - a wrong top-level type (number, object, …) warns and falls back to the default.
 * - an explicit empty list `[]` means "no overlay dep dirs" and is returned verbatim.
 *
 * Each entry must be a non-empty **relative** path with no glob metacharacters and
 * no `..` segment (can't escape the workspace), and must not resolve to the root.
 * Invalid entries are dropped **with a warning** — never fatal (dep dirs degrade
 * to a plain install). Surviving paths are normalized (collapse `./`, strip
 * trailing slash) and de-duplicated.
 */
function parseDepDirs(val: unknown, warnings: string[]): string[] {
  if (val === undefined || val === null) return [...DEFAULT_DEP_DIRS];

  let entries: unknown[];
  if (typeof val === "string") {
    entries = [val];
  } else if (Array.isArray(val)) {
    entries = val;
  } else {
    warnings.push("`agent.dep-dirs` must be a string or a list of strings; using the default [node_modules].");
    return [...DEFAULT_DEP_DIRS];
  }

  const seen = new Set<string>();
  const result: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const normalized = normalizeDepDir(entries[i], i, warnings);
    if (normalized === null) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

/** Structurally validate + normalize one `dep-dirs` entry; returns null (and warns) if invalid. */
function normalizeDepDir(entry: unknown, index: number, warnings: string[]): string | null {
  return normalizeLiteralRelPath(entry, "agent.dep-dirs", index, warnings);
}

/**
 * Parse `agent.install-inputs` (docs/197) — the explicit dependency-input file
 * set for the content-keyed install skip. Shares `dep-dirs`' structural rules
 * (literal relative paths, no globs, no `..`-escape, not the root), but its
 * *presence* semantics differ:
 *
 * - absent/null → `null` ("not configured"; the marker derives inputs from the
 *   install commands instead). This is NOT the `dep-dirs` default-list behavior.
 * - a bare string → a one-element list.
 * - a wrong top-level type → warn and fall back to `null` (not configured).
 * - an explicit list (including `[]`) → that list, verbatim after per-entry
 *   validation; it overrides the command-derived default.
 */
function parseInstallInputs(val: unknown, warnings: string[]): string[] | null {
  if (val === undefined || val === null) return null;

  let entries: unknown[];
  if (typeof val === "string") {
    entries = [val];
  } else if (Array.isArray(val)) {
    entries = val;
  } else {
    warnings.push("`agent.install-inputs` must be a string or a list of strings; ignoring it.");
    return null;
  }

  const seen = new Set<string>();
  const result: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const normalized = normalizeLiteralRelPath(entries[i], "agent.install-inputs", i, warnings);
    if (normalized === null) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

/**
 * Structurally validate + normalize one literal relative path entry (shared by
 * `dep-dirs` and `install-inputs`). Returns null (and warns under `label`) for
 * an absolute path, a glob, a `..`-escape, the workspace root, or a non-string.
 */
function normalizeLiteralRelPath(
  entry: unknown,
  label: string,
  index: number,
  warnings: string[],
): string | null {
  const drop = (reason: string): null => {
    warnings.push(`Ignoring \`${label}[${index}]\`: ${reason}.`);
    return null;
  };

  if (typeof entry !== "string") return drop("must be a string");
  const trimmed = entry.trim();
  if (!trimmed) return drop("must not be empty");
  if (trimmed.startsWith("/")) return drop(`must be a relative path, not absolute (\`${trimmed}\`)`);
  if (DEP_DIR_GLOB_CHARS.test(trimmed)) {
    return drop(`must be a literal path — globs are not supported (\`${trimmed}\`)`);
  }

  const segments = trimmed.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segments.some((s) => s === "..")) {
    return drop(`must stay inside the workspace — \`..\` is not allowed (\`${trimmed}\`)`);
  }
  if (segments.length === 0) return drop("must not be the workspace root");

  return segments.join("/");
}

function parseInstallList(val: unknown): string[] {
  if (val === undefined || val === null) return [];

  if (typeof val === "string") {
    const trimmed = val.trim();
    return trimmed ? [trimmed] : [];
  }

  if (Array.isArray(val)) {
    const result: string[] = [];
    for (let i = 0; i < val.length; i++) {
      if (typeof val[i] !== "string") {
        throw new ShipitConfigError(`\`agent.install[${i}]\` must be a string`);
      }
      const trimmed = (val[i] as string).trim();
      if (trimmed) result.push(trimmed);
    }
    return result;
  }

  throw new ShipitConfigError("`agent.install` must be a string or array of strings");
}

const KNOWN_RELEASE_KEYS = new Set([
  "version-source",
  "version-source-path",
  "branch",
  "tag-pattern",
  "prerelease-pattern",
  "notes",
  "gate",
  "mechanism",
  "workflow",
]);
const RELEASE_VERSION_SOURCES: ReadonlySet<string> = new Set([
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "VERSION",
  "tag",
]);
const RELEASE_MECHANISMS: ReadonlySet<string> = new Set(["tag-triggered", "brokered", "release-branch"]);

function parseReleaseConfig(raw: unknown, warnings: string[]): ReleaseConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ShipitConfigError("`release` must be a mapping (object)");
  }

  const obj = raw as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!KNOWN_RELEASE_KEYS.has(key)) {
      warnings.push(`Unknown key \`release.${key}\` in shipit.yaml.`);
    }
  }

  const result: ReleaseConfig = {};

  if ("version-source" in obj) {
    const vs = obj["version-source"];
    if (typeof vs !== "string" || !RELEASE_VERSION_SOURCES.has(vs)) {
      const allowed = [...RELEASE_VERSION_SOURCES].join(", ");
      throw new ShipitConfigError(`\`release.version-source\` must be one of: ${allowed}`);
    }
    result.versionSource = vs as ReleaseVersionSource;
  }

  if ("version-source-path" in obj) {
    const vsp = obj["version-source-path"];
    if (typeof vsp !== "string" || !vsp.trim()) {
      throw new ShipitConfigError("`release.version-source-path` must be a non-empty string");
    }
    result.versionSourcePath = vsp.trim();
  }

  if ("branch" in obj) {
    const b = obj.branch;
    if (typeof b !== "string" || !b.trim()) {
      throw new ShipitConfigError("`release.branch` must be a non-empty string");
    }
    result.branch = b.trim();
  }

  if ("tag-pattern" in obj) {
    const tp = obj["tag-pattern"];
    if (typeof tp !== "string" || !tp.includes("{version}")) {
      throw new ShipitConfigError("`release.tag-pattern` must be a string containing `{version}`");
    }
    result.tagPattern = tp;
  }

  if ("prerelease-pattern" in obj) {
    const pp = obj["prerelease-pattern"];
    if (typeof pp !== "string") {
      throw new ShipitConfigError("`release.prerelease-pattern` must be a string");
    }
    result.prereleasePattern = pp;
  }

  if ("notes" in obj) {
    const n = obj.notes;
    if (typeof n !== "string") {
      throw new ShipitConfigError("`release.notes` must be a string");
    }
    result.notes = n;
  }

  if ("gate" in obj) {
    const g = obj.gate;
    if (typeof g !== "string") {
      throw new ShipitConfigError("`release.gate` must be a string");
    }
    result.gate = g;
  }

  if ("mechanism" in obj) {
    const m = obj.mechanism;
    if (typeof m !== "string" || !RELEASE_MECHANISMS.has(m)) {
      const allowed = [...RELEASE_MECHANISMS].join(", ");
      throw new ShipitConfigError(`\`release.mechanism\` must be one of: ${allowed}`);
    }
    result.mechanism = m as ReleaseMechanism;
  }

  if ("workflow" in obj) {
    const w = obj.workflow;
    if (typeof w !== "string") {
      throw new ShipitConfigError("`release.workflow` must be a string");
    }
    result.workflow = w;
  }

  // docs/214 — `release-branch` derives the tag from a version file on the
  // merged commit, so it needs an authoritative file-backed version source. A
  // `tag` source has no file to read on a branch push, so it's invalid here.
  // (An absent `versionSource` is allowed: it falls back to auto-detection,
  // which a `release-branch` repo must resolve to a file at use time.)
  if (result.mechanism === "release-branch" && result.versionSource === "tag") {
    throw new ShipitConfigError(
      "`release.mechanism: release-branch` requires a file-backed `version-source` (package.json, Cargo.toml, pyproject.toml, or VERSION) — not `tag`.",
    );
  }

  return result;
}

function parseComposeConfig(raw: unknown): ComposeConfig | undefined {
  if (raw === undefined || raw === null) return undefined;

  // String form: compose: docker-compose.yml
  if (typeof raw === "string") {
    const file = raw.trim();
    if (!file) throw new ShipitConfigError("`compose` path must not be empty");
    return { file, dockerSocket: false };
  }

  // Object form: compose: { file: ..., docker-socket: ... }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;

    if (!("file" in obj) || typeof obj.file !== "string" || !obj.file.trim()) {
      throw new ShipitConfigError("`compose.file` is required and must be a non-empty string");
    }

    const dockerSocket = obj["docker-socket"] === true;

    return { file: obj.file.trim(), dockerSocket };
  }

  throw new ShipitConfigError("`compose` must be a string or object with a `file` field");
}

// ---------------------------------------------------------------------------
// File resolver
// ---------------------------------------------------------------------------

/**
 * Resolve shipit config from a shipit.yaml file in the given directory.
 * Returns defaults (with warnings) if the file doesn't exist or is empty.
 *
 * Compose must be explicitly specified via the `compose` key in shipit.yaml.
 * If not specified, compose is undefined and no services will be started.
 */
export function resolveShipitConfig(dir: string): ShipitConfig {
  const yamlPath = path.join(dir, "shipit.yaml");

  let config: ShipitConfig;

  // Try to read the file — only fall back to defaults on missing/unreadable file
  let content: string | undefined;
  try {
    content = fs.readFileSync(yamlPath, "utf-8");
  } catch {
    // File doesn't exist or can't be read — use defaults
    config = { agent: { ...AGENT_DEFAULTS, install: [] }, hostMounts: [], issues: { trackers: [] }, warnings: [] };
  }

  if (content !== undefined) {
    try {
      const parsed: unknown = parseYaml(content);
      config = parseShipitConfig(parsed);
    } catch (err) {
      if (err instanceof ShipitConfigError) throw err;
      // YAML syntax error — surface it instead of silently defaulting
      const message = err instanceof Error ? err.message : String(err);
      throw new ShipitConfigError(`Failed to parse shipit.yaml: ${message}`);
    }
  } else {
    // Already set above in the catch block, but TypeScript needs this
    config ??= { agent: { ...AGENT_DEFAULTS, install: [] }, hostMounts: [], issues: { trackers: [] }, warnings: [] };
  }

  return config;
}
