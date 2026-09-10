import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { ReleaseMechanism } from "./types/release-types.js";
import { normalizeLinearTeamKey, parseOwnerRepo } from "./tracker-id.js";
import type { DeclaredTracker } from "./declared-tracker.js";
import { declaredTrackerKey } from "./declared-tracker.js";
import type { PluginExport, PluginReposConfig } from "./plugin-repos.js";
import { EMPTY_PLUGIN_REPOS, parsePluginExports, parsePluginRepos } from "./plugin-repos.js";

export interface AgentConfig {
  install: string[];
  /** Literal relative paths; the overlay builder checks existence and tracked source. */
  depDirs: string[];
  /** null derives inputs from commands; any list, including [], replaces that default. */
  installInputs: string[] | null;
}

export interface ComposeConfig {
  /** Workspace-relative. */
  file: string;
  dockerSocket: boolean;
}

export type ReleaseVersionSource = "package.json" | "Cargo.toml" | "pyproject.toml" | "VERSION" | "tag";

export type { ReleaseMechanism } from "./types/release-types.js";

export interface ReleaseConfig {
  versionSource?: ReleaseVersionSource;
  /** Repo-relative location; versionSource selects the parser. */
  versionSourcePath?: string;
  branch?: string;
  tagPattern?: string;
  prereleasePattern?: string;
  notes?: string;
  gate?: string;
  mechanism?: ReleaseMechanism;
  workflow?: string;
}

/** Container creation must also require server-side kind === "ops". */
export interface HostMount {
  source: string;
  target: string;
  readOnly: true;
}

export type {
  DeclaredTracker,
  DeclaredGitHubTracker,
  DeclaredLinearTracker,
} from "./declared-tracker.js";

export interface IssuesConfig {
  trackers: DeclaredTracker[];
}

export interface ShipitConfig {
  version?: number;
  agent: AgentConfig;
  compose?: ComposeConfig;
  hostMounts: HostMount[];
  release?: ReleaseConfig;
  issues: IssuesConfig;
  plugins: PluginReposConfig;
  pluginExports: PluginExport[];
  warnings: string[];
}

export class ShipitConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShipitConfigError";
  }
}

export const DEFAULT_DEP_DIRS: readonly string[] = ["node_modules"];

export const AGENT_DEFAULTS: Readonly<AgentConfig> = {
  install: [],
  depDirs: [...DEFAULT_DEP_DIRS],
  installInputs: null,
};

const KNOWN_TOP_LEVEL_KEYS = new Set([
  "version",
  "agent",
  "compose",
  "release",
  "issues",
  "x-shipit-host-mounts",
  "plugins",
  "exports",
]);
const KNOWN_AGENT_KEYS = new Set(["install", "dep-dirs", "install-inputs"]);

const DEPRECATED_AGENT_KEYS: Record<string, string> = {
  memory:
    "`agent.memory` is no longer used — session memory is sized automatically from host capacity (docs/229). Set the deployment env `DEFAULT_SESSION_MEMORY_MB` / `MAX_SESSION_MEMORY_MB` to override.",
  cpu: "`agent.cpu` is no longer used — CPU is no longer a per-repo limit (docs/229).",
  pids: "`agent.pids` is no longer used — the per-session process ceiling is fixed (docs/229).",
};

export const ALLOWED_HOST_MOUNT_SOURCES: Readonly<Record<string, string>> = {
  "/var/run/docker.sock": "/var/run/docker.sock",
  "/var/log/journal": "/var/log/journal",
  "/run/log/journal": "/run/log/journal",
};

const OLD_FORMAT_KEYS: Record<string, string> = {
  preview: "The `preview` block has been removed. Define services in docker-compose.yml instead. See /shipit-docs/compose.md.",
  resources: "The `resources` block has been removed. Session sizing is automatic (docs/229); preview resources are set per-service in docker-compose.yml.",
  capabilities: "The `capabilities` block has been replaced. Use `compose.docker-socket: true` instead of `capabilities.docker: true`.",
  services: "The `services` block has been removed. Define services in docker-compose.yml instead.",
  install: "The top-level `install` field has moved to `agent.install`.",
};

export function parseShipitConfig(doc: unknown): ShipitConfig {
  const warnings: string[] = [];

  if (doc === null || doc === undefined) {
    return {
      agent: { ...AGENT_DEFAULTS, install: [] },
      hostMounts: [],
      issues: { trackers: [] },
      plugins: { ...EMPTY_PLUGIN_REPOS },
      pluginExports: [],
      warnings,
    };
  }

  if (typeof doc !== "object" || Array.isArray(doc)) {
    throw new ShipitConfigError("shipit.yaml must be a YAML mapping (object)");
  }

  const raw = doc as Record<string, unknown>;

  for (const [key, hint] of Object.entries(OLD_FORMAT_KEYS)) {
    if (key in raw) {
      warnings.push(hint);
    }
  }

  for (const key of Object.keys(raw)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key) && !(key in OLD_FORMAT_KEYS)) {
      warnings.push(`Unknown top-level key \`${key}\` in shipit.yaml.`);
    }
  }

  let version: number | undefined;
  if ("version" in raw) {
    if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1) {
      throw new ShipitConfigError("`version` must be a positive integer");
    }
    version = raw.version;
  }

  const agent = parseAgentConfig(raw.agent, warnings);

  const compose = parseComposeConfig(raw.compose);

  const release = parseReleaseConfig(raw.release, warnings);

  const issues = parseIssuesConfig(raw.issues, warnings);

  // Trackers reserve names before plugin repositories.
  const plugins = "plugins" in raw ? parsePluginRepos(raw.plugins, issues.trackers, warnings) : { ...EMPTY_PLUGIN_REPOS };
  const pluginExports = parsePluginExports(raw.exports, warnings);

  const hostMounts = parseHostMounts(raw["x-shipit-host-mounts"]);

  return { version, agent, compose, release, issues, plugins, pluginExports, hostMounts, warnings };
}

const KNOWN_ISSUES_KEYS = new Set(["trackers"]);
const KNOWN_GITHUB_TRACKER_KEYS = new Set(["kind", "name", "label", "repo"]);
const KNOWN_LINEAR_TRACKER_KEYS = new Set(["kind", "name", "label", "team"]);

/** Must be addressable as name#id. */
const TRACKER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Invalid or unknown trackers warn and skip; they must not prevent session startup. */
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
  const seenNames = new Set<string>();
  const seenDestinations = new Map<string, string>();
  for (let i = 0; i < rawTrackers.length; i++) {
    const entry = parseDeclaredTracker(rawTrackers[i], i, warnings);
    if (!entry) continue;
    const nameKey = entry.name.toLowerCase();
    if (seenNames.has(nameKey)) {
      warnings.push(
        `Ignoring \`issues.trackers[${i}]\`: duplicate tracker name \`${entry.name}\` — names must be unique within a repository.`,
      );
      continue;
    }
    const destinationKey = declaredTrackerKey(entry).toLowerCase();
    const claimedBy = seenDestinations.get(destinationKey);
    if (claimedBy) {
      warnings.push(
        `Ignoring \`issues.trackers[${i}]\`: \`${declaredTrackerKey(entry)}\` is already declared as \`${claimedBy}\` — a destination may only be declared once.`,
      );
      continue;
    }
    seenNames.add(nameKey);
    seenDestinations.set(destinationKey, entry.name);
    trackers.push(entry);
  }
  return { trackers };
}

function parseDeclaredTracker(entry: unknown, index: number, warnings: string[]): DeclaredTracker | null {
  const drop = (reason: string): null => {
    warnings.push(`Ignoring \`issues.trackers[${index}]\`: ${reason}.`);
    return null;
  };

  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return drop("each entry must be a mapping with a `kind`");
  }
  const obj = entry as Record<string, unknown>;
  const rawKind = obj.kind;
  if (typeof rawKind !== "string" || !rawKind.trim()) {
    return drop("each entry must state its tracker `kind` (e.g. `kind: github`)");
  }
  const kind = rawKind.trim().toLowerCase();
  if (kind !== "github" && kind !== "linear") {
    return drop(
      `unrecognized tracker \`kind: ${rawKind}\` — this version of ShipIt supports \`github\` and \`linear\``,
    );
  }

  const knownKeys = kind === "github" ? KNOWN_GITHUB_TRACKER_KEYS : KNOWN_LINEAR_TRACKER_KEYS;
  for (const key of Object.keys(obj)) {
    if (!knownKeys.has(key)) {
      warnings.push(`Unknown key \`issues.trackers[${index}].${key}\` in shipit.yaml.`);
    }
  }

  const rawName = obj.name;
  if (typeof rawName !== "string" || !rawName.trim()) {
    return drop("each entry needs a `name:` — it is how references and operations address this tracker");
  }
  const name = rawName.trim();
  if (!TRACKER_NAME_RE.test(name)) {
    return drop(
      `\`name: ${name}\` must be letters, digits, \`.\`, \`_\` or \`-\` (it has to be writable as \`${name}#42\`)`,
    );
  }

  const label = parseTrackerLabel(obj.label, index, warnings);
  const labelField = label ? { label } : {};

  if (kind === "github") {
    const repoSlug = obj.repo;
    if (typeof repoSlug !== "string" || !repoSlug.trim()) {
      return drop("a `github` tracker needs `repo: owner/name`");
    }
    const ref = parseOwnerRepo(repoSlug);
    if (!ref) {
      return drop(`\`repo: ${repoSlug}\` must be an \`owner/name\` slug`);
    }
    return { kind: "github", name, ...labelField, owner: ref.owner, repo: ref.repo };
  }

  const rawTeam = obj.team;
  if (typeof rawTeam !== "string" || !rawTeam.trim()) {
    return drop("a `linear` tracker needs `team: KEY` (the team key its issue keys are prefixed with)");
  }
  const team = normalizeLinearTeamKey(rawTeam);
  if (!team) {
    return drop(`\`team: ${rawTeam}\` must be a Linear team key like \`SHI\``);
  }
  return { kind: "linear", name, ...labelField, team };
}

function parseTrackerLabel(raw: unknown, index: number, warnings: string[]): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || !raw.trim()) {
    warnings.push(
      `Ignoring \`issues.trackers[${index}].label\`: it must be a non-empty string; using the tracker \`name\` instead.`,
    );
    return undefined;
  }
  return raw.trim();
}

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

const DEP_DIR_GLOB_CHARS = /[*?[\]{}]/;

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

function normalizeDepDir(entry: unknown, index: number, warnings: string[]): string | null {
  return normalizeLiteralRelPath(entry, "agent.dep-dirs", index, warnings);
}

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

  if (result.mechanism === "release-branch" && result.versionSource === "tag") {
    throw new ShipitConfigError(
      "`release.mechanism: release-branch` requires a file-backed `version-source` (package.json, Cargo.toml, pyproject.toml, or VERSION) — not `tag`.",
    );
  }

  return result;
}

function parseComposeConfig(raw: unknown): ComposeConfig | undefined {
  if (raw === undefined || raw === null) return undefined;

  if (typeof raw === "string") {
    const file = raw.trim();
    if (!file) throw new ShipitConfigError("`compose` path must not be empty");
    return { file, dockerSocket: false };
  }

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

export function resolveShipitConfig(dir: string): ShipitConfig {
  const yamlPath = path.join(dir, "shipit.yaml");

  let config: ShipitConfig;

  let content: string | undefined;
  try {
    content = fs.readFileSync(yamlPath, "utf-8");
  } catch {
    config = {
      agent: { ...AGENT_DEFAULTS, install: [] },
      hostMounts: [],
      issues: { trackers: [] },
      plugins: { ...EMPTY_PLUGIN_REPOS },
      pluginExports: [],
      warnings: [],
    };
  }

  if (content !== undefined) {
    try {
      const parsed: unknown = parseYaml(content);
      config = parseShipitConfig(parsed);
    } catch (err) {
      if (err instanceof ShipitConfigError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new ShipitConfigError(`Failed to parse shipit.yaml: ${message}`);
    }
  } else {
    config ??= {
      agent: { ...AGENT_DEFAULTS, install: [] },
      hostMounts: [],
      issues: { trackers: [] },
      plugins: { ...EMPTY_PLUGIN_REPOS },
      pluginExports: [],
      warnings: [],
    };
  }

  return config;
}
