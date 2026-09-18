/** Shared with the browser; keep filesystem imports out. */
import { parseOwnerRepo } from "./tracker-id.js";
import type { DeclaredTracker } from "./declared-tracker.js";
import { PLUGIN_CONTRACT_ENV_NAMES } from "./plugin-contract.js";
import type { PluginCredentialGroup, PluginCredentialNeed } from "./plugin-credentials.js";
import type { PluginHostGroup, PluginHostNeed } from "./plugin-hosts.js";

export type PluginRepoSource =
  | { kind: "github"; owner: string; repo: string }
  | { kind: "self" };

export interface DeclaredPluginRepo {
  name: string;
  source: PluginRepoSource;
  branch?: string;
  pin?: string;
}

export interface PluginServiceOverride {
  autostart?: boolean;
  as?: string;
  /** Consumer-selected container and preview port; absent means no preview. */
  port?: number;
}

export interface PluginUseOverrides {
  services: Record<string, PluginServiceOverride>;
  commands: Record<string, { as?: string }>;
  settings: Record<string, string | number | boolean>;
}

export interface PluginUse {
  plugin: string;
  from: string;
  alias: string;
  overrides: PluginUseOverrides;
}

export interface PluginReposConfig {
  /** Key presence, even if invalid, keeps the tab available to show warnings. */
  declared: boolean;
  repos: DeclaredPluginRepo[];
  uses: PluginUse[];
}

export interface PluginRequirement {
  name: string;
  /** Changes reporting only; grants no access and does not suppress available credentials. */
  optional: boolean;
}

export interface PluginExport {
  name: string;
  compose?: string;
  cli: Record<string, string>;
  skills?: string;
  install?: string;
  installInputs: string[];
  depDirs: string[];
  credentials: PluginRequirement[];
  /** Informational; grants no network access. */
  hosts: PluginRequirement[];
  settings: Record<string, { description?: string; default?: string | number | boolean }>;
}

export const EMPTY_PLUGIN_REPOS: Readonly<PluginReposConfig> = Object.freeze({
  declared: false,
  repos: [],
  uses: [],
});

export interface PluginRepoUseView {
  plugin: string;
  alias: string;
  /** null until a manifest is available. */
  found: boolean | null;
  credentials: PluginCredentialNeed[];
  hosts: PluginHostNeed[];
}

/** degraded keeps the previous generation live; unavailable has none. */
export type PluginRepoStatus = "self" | "active" | "activating" | "degraded" | "unavailable";

export interface PluginRepoCardView {
  name: string;
  source: string;
  /** Live generation's ref, paired with commit; declaration only when nothing is live. */
  ref: string | null;
  commit: string | null;
  status: PluginRepoStatus;
  pinned: boolean;
  uses: PluginRepoUseView[];
  issues: string[];
  /** Advisory only; must not affect issue counts or the attention dot. */
  depStoreNotice?: string;
}

export interface PluginRepoRuntime {
  activating?: boolean;
  commit?: string;
  ref?: string;
  exports?: string[];
  error?: string;
  warning?: string;
  manifestWarnings?: string[];
  missingSelectors?: string[];
  settingsIssues?: string[];
  commandIssues?: string[];
  serviceIssues?: string[];
  depStoreNotice?: string;
}

export interface PluginReposSnapshot {
  declared: boolean;
  activating: boolean;
  /** Checkout unavailable; retry instead of caching an empty declaration. */
  pending: boolean;
  consumerRepoUrl: string | null;
  repos: PluginRepoCardView[];
  warnings: string[];
}

const PLUGIN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const KNOWN_REPO_KEYS = new Set(["repo", "name", "branch", "pin"]);
const KNOWN_USE_KEYS = new Set(["plugin", "from", "alias", "overrides"]);
const KNOWN_OVERRIDE_KEYS = new Set(["services", "commands", "settings"]);
const KNOWN_SERVICE_OVERRIDE_KEYS = new Set(["autostart", "as", "port"]);
const KNOWN_COMMAND_OVERRIDE_KEYS = new Set(["as"]);

function isMapping(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isScalar(v: unknown): v is string | number | boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/** Call only when the plugins key exists; even null declares intent. */
export function parsePluginRepos(
  raw: unknown,
  trackers: readonly DeclaredTracker[],
  warnings: string[],
): PluginReposConfig {
  if (raw === undefined || raw === null) return { declared: true, repos: [], uses: [] };

  if (!isMapping(raw)) {
    warnings.push("`plugins` must be a mapping (object); ignoring it.");
    return { declared: true, repos: [], uses: [] };
  }

  for (const key of Object.keys(raw)) {
    if (key !== "repos" && key !== "use") {
      warnings.push(`Unknown key \`plugins.${key}\` in shipit.yaml.`);
    }
  }

  const repos = parseRepoList(raw.repos, trackers, warnings);
  const uses = parseUseList(raw.use, repos, warnings);
  return { declared: true, repos, uses };
}

function parseRepoList(
  raw: unknown,
  trackers: readonly DeclaredTracker[],
  warnings: string[],
): DeclaredPluginRepo[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    warnings.push("`plugins.repos` must be a list; ignoring it.");
    return [];
  }

  const trackerNames = new Map<string, DeclaredTracker>(
    trackers.map((t) => [t.name.toLowerCase(), t]),
  );
  const seenNames = new Set<string>();
  const seenDestinations = new Map<string, string>();
  const repos: DeclaredPluginRepo[] = [];

  for (let i = 0; i < raw.length; i++) {
    const repo = parseRepoEntry(raw[i], i, warnings);
    if (!repo) continue;

    const nameKey = repo.name.toLowerCase();
    // Tracker names take precedence, unless both point to the same repository.
    const tracker = trackerNames.get(nameKey);
    if (tracker && !sameDestination(repo.source, tracker)) {
      warnings.push(
        `Ignoring \`plugins.repos[${i}]\`: \`${repo.name}\` is already a declared tracker name — repo and tracker names share one namespace (first declared wins).`,
      );
      continue;
    }
    if (seenNames.has(nameKey)) {
      warnings.push(
        `Ignoring \`plugins.repos[${i}]\`: duplicate repo name \`${repo.name}\`.`,
      );
      continue;
    }
    const destKey = destinationKey(repo.source);
    const claimedBy = seenDestinations.get(destKey);
    if (claimedBy) {
      warnings.push(
        `Ignoring \`plugins.repos[${i}]\`: \`${destKey}\` is already declared as \`${claimedBy}\` — a repository may only be declared once.`,
      );
      continue;
    }
    seenNames.add(nameKey);
    seenDestinations.set(destKey, repo.name);
    repos.push(repo);
  }
  return repos;
}

/** Repository identity, independent of the declaration's mutable name. */
export function destinationKey(source: PluginRepoSource): string {
  return source.kind === "self" ? "self" : `${source.owner}/${source.repo}`.toLowerCase();
}

/** Preserve case: cache paths hash the URL byte-for-byte. */
export function pluginCloneUrl(source: PluginRepoSource): string {
  if (source.kind === "self") throw new Error("self repos have no clone URL");
  return `https://github.com/${source.owner}/${source.repo}.git`;
}

export function declaredRefLabel(repo: Pick<DeclaredPluginRepo, "branch" | "pin">): string {
  return repo.pin ? `pin ${repo.pin}` : `branch ${repo.branch ?? "(default)"}`;
}

function sameDestination(source: PluginRepoSource, tracker: DeclaredTracker): boolean {
  return (
    source.kind === "github" &&
    tracker.kind === "github" &&
    source.owner.toLowerCase() === tracker.owner.toLowerCase() &&
    source.repo.toLowerCase() === tracker.repo.toLowerCase()
  );
}

function parseRepoEntry(entry: unknown, index: number, warnings: string[]): DeclaredPluginRepo | null {
  const drop = (reason: string): null => {
    warnings.push(`Ignoring \`plugins.repos[${index}]\`: ${reason}.`);
    return null;
  };

  if (!isMapping(entry)) return drop("each entry must be a mapping with `repo:` and `name:`");

  for (const key of Object.keys(entry)) {
    if (!KNOWN_REPO_KEYS.has(key)) {
      warnings.push(`Unknown key \`plugins.repos[${index}].${key}\` in shipit.yaml.`);
    }
  }

  const rawRepo = entry.repo;
  if (typeof rawRepo !== "string" || !rawRepo.trim()) {
    return drop("each entry needs `repo: owner/name` (or `repo: self`)");
  }
  const repoStr = rawRepo.trim();

  const rawName = entry.name;
  if (typeof rawName !== "string" || !rawName.trim()) {
    return drop("each entry needs a `name:` — it is the checkout path, card, and refresh target");
  }
  const name = rawName.trim();
  if (!PLUGIN_NAME_RE.test(name)) {
    return drop(`\`name: ${name}\` must be letters, digits, \`.\`, \`_\` or \`-\``);
  }

  const branch = optionalTrimmedString(entry.branch, `plugins.repos[${index}].branch`, warnings);
  const pin = optionalTrimmedString(entry.pin, `plugins.repos[${index}].pin`, warnings);
  if (branch === false || pin === false) return null;
  if (branch && pin) return drop("`branch` and `pin` are mutually exclusive (req 8)");

  if (repoStr.toLowerCase() === "self") {
    if (branch || pin) return drop("`repo: self` takes no `branch`/`pin` — the live working tree has no tracked version");
    return { name, source: { kind: "self" } };
  }

  const ref = parseOwnerRepo(repoStr);
  if (!ref) {
    return drop(`\`repo: ${repoStr}\` must be an \`owner/name\` slug or \`self\` (GitHub-only in v1)`);
  }
  return {
    name,
    source: { kind: "github", owner: ref.owner, repo: ref.repo },
    ...(branch ? { branch } : {}),
    ...(pin ? { pin } : {}),
  };
}

/** false drops an invalid entry so a bad pin cannot become default-branch tracking. */
function optionalTrimmedString(
  raw: unknown,
  label: string,
  warnings: string[],
): string | undefined | false {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || !raw.trim()) {
    warnings.push(`Ignoring the entry: \`${label}\` must be a non-empty string.`);
    return false;
  }
  return raw.trim();
}

function parseUseList(
  raw: unknown,
  repos: readonly DeclaredPluginRepo[],
  warnings: string[],
): PluginUse[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    warnings.push("`plugins.use` must be a list; ignoring it.");
    return [];
  }

  const repoNames = new Set(repos.map((r) => r.name.toLowerCase()));
  const seenAliases = new Set<string>();
  const uses: PluginUse[] = [];

  for (let i = 0; i < raw.length; i++) {
    const entry: unknown = raw[i];
    const drop = (reason: string): void => {
      warnings.push(`Ignoring \`plugins.use[${i}]\`: ${reason}.`);
    };

    if (!isMapping(entry)) {
      drop("each entry must be a mapping with `plugin:` and `from:`");
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (!KNOWN_USE_KEYS.has(key)) {
        warnings.push(
          KNOWN_OVERRIDE_KEYS.has(key)
            ? `Unknown key \`plugins.use[${i}].${key}\` in shipit.yaml — its value is ignored. A `
              + `consuming project's \`${key}\` goes under \`overrides:\`, i.e. `
              + `\`plugins.use[${i}].overrides.${key}\`.`
            : `Unknown key \`plugins.use[${i}].${key}\` in shipit.yaml.`,
        );
      }
    }

    const plugin = typeof entry.plugin === "string" ? entry.plugin.trim() : "";
    if (!plugin || !PLUGIN_NAME_RE.test(plugin)) {
      drop("each entry needs `plugin:` — the exported plugin to activate");
      continue;
    }
    const from = typeof entry.from === "string" ? entry.from.trim() : "";
    if (!from) {
      drop("each entry needs `from:` — a declared repo name");
      continue;
    }
    if (!repoNames.has(from.toLowerCase())) {
      drop(`\`from: ${from}\` names no declared repo`);
      continue;
    }

    let alias = plugin;
    if (entry.alias !== undefined && entry.alias !== null) {
      if (typeof entry.alias !== "string" || !PLUGIN_NAME_RE.test(entry.alias.trim())) {
        drop("`alias` must be letters, digits, `.`, `_` or `-`");
        continue;
      }
      alias = entry.alias.trim();
    }
    const aliasKey = alias.toLowerCase();
    if (seenAliases.has(aliasKey)) {
      drop(`duplicate plugin alias \`${alias}\``);
      continue;
    }

    const overrides = parseOverrides(entry.overrides, i, warnings);
    if (!overrides) continue;

    seenAliases.add(aliasKey);
    uses.push({ plugin, from, alias, overrides });
  }
  return uses;
}

/** Drop the entire use entry on invalid overrides; defaults could start unwanted services. */
function parseOverrides(
  raw: unknown,
  useIndex: number,
  warnings: string[],
): PluginUseOverrides | null {
  const empty: PluginUseOverrides = { services: {}, commands: {}, settings: {} };
  if (raw === undefined || raw === null) return empty;

  const fail = (field: string, reason: string): null => {
    warnings.push(`Ignoring \`plugins.use[${useIndex}]\`: \`${field}\` ${reason}.`);
    return null;
  };

  if (!isMapping(raw)) return fail("overrides", "must be a mapping");

  for (const key of Object.keys(raw)) {
    if (!KNOWN_OVERRIDE_KEYS.has(key)) {
      warnings.push(`Unknown key \`plugins.use[${useIndex}].overrides.${key}\` in shipit.yaml.`);
    }
  }

  const services: Record<string, PluginServiceOverride> = {};
  if (raw.services !== undefined && raw.services !== null) {
    if (!isMapping(raw.services)) return fail("overrides.services", "must be a mapping keyed by service name");
    for (const [svc, val] of Object.entries(raw.services)) {
      const field = `overrides.services.${svc}`;
      if (!isMapping(val)) return fail(field, "must be a mapping");
      for (const key of Object.keys(val)) {
        if (!KNOWN_SERVICE_OVERRIDE_KEYS.has(key)) {
          warnings.push(`Unknown key \`plugins.use[${useIndex}].${field}.${key}\` in shipit.yaml.`);
        }
      }
      const out: PluginServiceOverride = {};
      if (val.autostart !== undefined && val.autostart !== null) {
        if (typeof val.autostart !== "boolean") return fail(`${field}.autostart`, "must be true or false");
        out.autostart = val.autostart;
      }
      if (val.as !== undefined && val.as !== null) {
        const as = parseAlias(val.as);
        if (!as) return fail(`${field}.as`, "must be letters, digits, `.`, `_` or `-`");
        out.as = as;
      }
      if (val.port !== undefined && val.port !== null) {
        if (typeof val.port !== "number" || !Number.isInteger(val.port) || val.port < 1 || val.port > 65_535) {
          return fail(`${field}.port`, "must be a whole number between 1 and 65535");
        }
        out.port = val.port;
      }
      services[svc] = out;
    }
  }

  const commands: Record<string, { as?: string }> = {};
  if (raw.commands !== undefined && raw.commands !== null) {
    if (!isMapping(raw.commands)) return fail("overrides.commands", "must be a mapping keyed by command name");
    for (const [cmd, val] of Object.entries(raw.commands)) {
      const field = `overrides.commands.${cmd}`;
      if (!isMapping(val)) return fail(field, "must be a mapping");
      for (const key of Object.keys(val)) {
        if (!KNOWN_COMMAND_OVERRIDE_KEYS.has(key)) {
          warnings.push(`Unknown key \`plugins.use[${useIndex}].${field}.${key}\` in shipit.yaml.`);
        }
      }
      const out: { as?: string } = {};
      if (val.as !== undefined && val.as !== null) {
        const as = parseAlias(val.as);
        if (!as) return fail(`${field}.as`, "must be letters, digits, `.`, `_` or `-`");
        out.as = as;
      }
      commands[cmd] = out;
    }
  }

  const settings: Record<string, string | number | boolean> = {};
  if (raw.settings !== undefined && raw.settings !== null) {
    if (!isMapping(raw.settings)) return fail("overrides.settings", "must be a mapping");
    for (const [name, val] of Object.entries(raw.settings)) {
      if (!isScalar(val)) return fail(`overrides.settings.${name}`, "must be a scalar");
      settings[name] = val;
    }
  }

  return { services, commands, settings };
}

function parseAlias(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !PLUGIN_NAME_RE.test(raw.trim())) return undefined;
  return raw.trim();
}

const KNOWN_EXPORT_KEYS = new Set([
  "compose",
  "cli",
  "skills",
  "install",
  "install-inputs",
  "dep-dirs",
  "credentials",
  "hosts",
  "settings",
]);

/** Duplicate the config default to avoid its filesystem imports. */
export const DEFAULT_PLUGIN_DEP_DIRS: readonly string[] = ["node_modules"];

const CREDENTIAL_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
const KNOWN_REQUIREMENT_KEYS = new Set(["name", "optional"]);

function parseRequirementList(
  raw: unknown,
  field: "credentials" | "hosts",
  exportName: string,
  warnings: string[],
): PluginRequirement[] | { error: string } {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    return {
      error: field === "credentials"
        ? "`credentials` must be a list of credential NAMES"
        : "`hosts` must be a list of hostnames",
    };
  }

  const out: PluginRequirement[] = [];
  for (const entry of raw) {
    let value: unknown = entry;
    let optional = false;
    if (isMapping(entry)) {
      for (const key of Object.keys(entry)) {
        if (!KNOWN_REQUIREMENT_KEYS.has(key)) {
          warnings.push(
            `Unknown key \`exports.plugins.${exportName}.${field}[].${key}\` in shipit.yaml.`,
          );
        }
      }
      if (entry.name === undefined || entry.name === null) {
        return { error: `each \`${field}\` entry needs a \`name:\`` };
      }
      value = entry.name;
      if (entry.optional !== undefined && entry.optional !== null) {
        if (typeof entry.optional !== "boolean") {
          return { error: `\`${field}\` entries take \`optional: true\` or \`optional: false\`` };
        }
        optional = entry.optional;
      }
    }

    const nameError = requirementNameError(field, value);
    if (nameError) return { error: nameError };
    out.push({ name: value as string, optional });
  }
  return out;
}

function requirementNameError(field: "credentials" | "hosts", value: unknown): string | null {
  if (field === "hosts") {
    return typeof value === "string" && HOST_RE.test(value)
      ? null
      : `hosts must be bare hostnames like \`fal.run\` (got \`${String(value)}\`)`;
  }
  if (typeof value !== "string" || !CREDENTIAL_NAME_RE.test(value)) {
    return `credential names must look like environment variables (got \`${String(value)}\`)`;
  }
  return PLUGIN_CONTRACT_ENV_NAMES.has(value)
    ? `\`${value}\` is set by ShipIt in every plugin container, so a plugin cannot declare it as a credential`
    : null;
}

/** Invalid fields drop the whole plugin, never a partial executable export. */
export function parsePluginExports(raw: unknown, warnings: string[]): PluginExport[] {
  if (raw === undefined || raw === null) return [];
  if (!isMapping(raw)) {
    warnings.push("`exports` must be a mapping (object); ignoring it.");
    return [];
  }
  for (const key of Object.keys(raw)) {
    if (key !== "plugins") {
      warnings.push(`Unknown key \`exports.${key}\` in shipit.yaml.`);
    }
  }
  const rawPlugins = raw.plugins;
  if (rawPlugins === undefined || rawPlugins === null) return [];
  if (!isMapping(rawPlugins)) {
    warnings.push("`exports.plugins` must be a mapping keyed by plugin name; ignoring it.");
    return [];
  }

  const exportsList: PluginExport[] = [];
  for (const [name, entry] of Object.entries(rawPlugins)) {
    const parsed = parseExportEntry(name, entry, warnings);
    if (parsed) exportsList.push(parsed);
  }
  return exportsList;
}

function parseExportEntry(name: string, entry: unknown, warnings: string[]): PluginExport | null {
  // Snapshot warning filters require the full quoted config key.
  const drop = (reason: string): null => {
    warnings.push(`Ignoring \`exports.plugins.${name}\`: ${reason}.`);
    return null;
  };

  if (!PLUGIN_NAME_RE.test(name)) {
    return drop("plugin names must be letters, digits, `.`, `_` or `-`");
  }
  if (!isMapping(entry)) return drop("each plugin must be a mapping");

  for (const key of Object.keys(entry)) {
    if (!KNOWN_EXPORT_KEYS.has(key)) {
      warnings.push(`Unknown key \`exports.plugins.${name}.${key}\` in shipit.yaml.`);
    }
  }

  const compose = optionalRelPath(entry.compose, `exports.plugins.${name}.compose`);
  const skills = optionalRelPath(entry.skills, `exports.plugins.${name}.skills`);
  if (typeof compose === "object") return drop(compose.error);
  if (typeof skills === "object") return drop(skills.error);

  let install: string | undefined;
  if (entry.install !== undefined && entry.install !== null) {
    if (typeof entry.install !== "string" || !entry.install.trim()) {
      return drop("`install` must be a non-empty string");
    }
    install = entry.install.trim();
  }

  const cli: Record<string, string> = {};
  if (entry.cli !== undefined && entry.cli !== null) {
    if (!isMapping(entry.cli)) return drop("`cli` must be a mapping of command name → entrypoint path");
    for (const [cmd, p] of Object.entries(entry.cli)) {
      if (!PLUGIN_NAME_RE.test(cmd)) return drop(`command name \`${cmd}\` must be letters, digits, \`.\`, \`_\` or \`-\``);
      const rel = optionalRelPath(p, `exports.plugins.${name}.cli.${cmd}`);
      if (rel === undefined || typeof rel === "object") {
        return drop(typeof rel === "object" ? rel.error : `\`cli.${cmd}\` needs an entrypoint path`);
      }
      cli[cmd] = rel;
    }
  }

  const installInputs: string[] = [];
  if (entry["install-inputs"] !== undefined && entry["install-inputs"] !== null) {
    const rawInputs = entry["install-inputs"];
    if (!Array.isArray(rawInputs)) return drop("`install-inputs` must be a list of file paths");
    for (let i = 0; i < rawInputs.length; i++) {
      const rel = optionalRelPath(rawInputs[i], `exports.plugins.${name}.install-inputs[${i}]`);
      if (rel === undefined || typeof rel === "object") {
        return drop(typeof rel === "object" ? rel.error : `\`install-inputs[${i}]\` must be a path`);
      }
      installInputs.push(rel);
    }
  }

  let depDirs: string[] = [...DEFAULT_PLUGIN_DEP_DIRS];
  if (entry["dep-dirs"] !== undefined && entry["dep-dirs"] !== null) {
    const rawDirs = entry["dep-dirs"];
    if (!Array.isArray(rawDirs)) return drop("`dep-dirs` must be a list of directory paths");
    const seen = new Set<string>();
    depDirs = [];
    for (let i = 0; i < rawDirs.length; i++) {
      const rel = optionalRelPath(rawDirs[i], `exports.plugins.${name}.dep-dirs[${i}]`);
      if (rel === undefined || typeof rel === "object") {
        return drop(typeof rel === "object" ? rel.error : `\`dep-dirs[${i}]\` must be a path`);
      }
      if (seen.has(rel)) continue;
      seen.add(rel);
      depDirs.push(rel);
    }
  }

  const credentials = parseRequirementList(entry.credentials, "credentials", name, warnings);
  if (!Array.isArray(credentials)) return drop(credentials.error);
  const hosts = parseRequirementList(entry.hosts, "hosts", name, warnings);
  if (!Array.isArray(hosts)) return drop(hosts.error);

  const settings: PluginExport["settings"] = {};
  if (entry.settings !== undefined && entry.settings !== null) {
    if (!isMapping(entry.settings)) return drop("`settings` must be a mapping keyed by setting name");
    for (const [sName, sVal] of Object.entries(entry.settings)) {
      if (!PLUGIN_NAME_RE.test(sName)) return drop(`setting name \`${sName}\` must be letters, digits, \`.\`, \`_\` or \`-\``);
      if (sVal === null || sVal === undefined) {
        settings[sName] = {};
        continue;
      }
      if (!isMapping(sVal)) return drop(`\`settings.${sName}\` must be a mapping (description/default)`);
      for (const key of Object.keys(sVal)) {
        if (key !== "description" && key !== "default") {
          warnings.push(`Unknown key \`exports.plugins.${name}.settings.${sName}.${key}\` in shipit.yaml.`);
        }
      }
      const out: { description?: string; default?: string | number | boolean } = {};
      if (sVal.description !== undefined) {
        if (typeof sVal.description !== "string") return drop(`\`settings.${sName}.description\` must be a string`);
        out.description = sVal.description;
      }
      if (sVal.default !== undefined) {
        if (!isScalar(sVal.default)) return drop(`\`settings.${sName}.default\` must be a scalar`);
        out.default = sVal.default;
      }
      settings[sName] = out;
    }
  }

  return {
    name,
    ...(compose !== undefined ? { compose } : {}),
    cli,
    ...(skills !== undefined ? { skills } : {}),
    ...(install !== undefined ? { install } : {}),
    installInputs,
    depDirs,
    credentials,
    hosts,
    settings,
  };
}

/** Duplicate structural path validation to keep filesystem imports out. */
function optionalRelPath(
  raw: unknown,
  label: string,
): string | undefined | { error: string } {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || !raw.trim()) return { error: `\`${label}\` must be a non-empty path` };
  const trimmed = raw.trim();
  if (trimmed.startsWith("/")) return { error: `\`${label}\` must be a relative path` };
  if (/[*?[\]{}]/.test(trimmed)) return { error: `\`${label}\` must be a literal path — no globs` };
  const segments = trimmed.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segments.some((s) => s === "..")) return { error: `\`${label}\` must stay inside the repository` };
  if (segments.length === 0) return { error: `\`${label}\` must not be the repository root` };
  return segments.join("/");
}

export function buildPluginReposSnapshot(
  plugins: PluginReposConfig,
  pluginExports: readonly PluginExport[],
  consumerRepoUrl: string | null,
  warnings: readonly string[],
  runtime: Readonly<Record<string, PluginRepoRuntime>> = {},
  credentialGroups: readonly PluginCredentialGroup[] = [],
  hostGroups: readonly PluginHostGroup[] = [],
): PluginReposSnapshot {
  const selfExports = new Set(pluginExports.map((e) => e.name.toLowerCase()));
  const needsByAlias = new Map(credentialGroups.map((g) => [g.alias.toLowerCase(), g.credentials]));
  const hostsByAlias = new Map(hostGroups.map((g) => [g.alias.toLowerCase(), g.hosts]));

  const repos: PluginRepoCardView[] = plugins.repos.map((repo) => {
    const isSelf = repo.source.kind === "self";
    const live = runtime[repo.name] ?? {};
    const manifest = isSelf ? selfExports : live.exports ? new Set(live.exports.map((n) => n.toLowerCase())) : null;

    const uses = plugins.uses
      .filter((u) => u.from.toLowerCase() === repo.name.toLowerCase())
      .map((u) => ({
        plugin: u.plugin,
        alias: u.alias,
        found: manifest ? manifest.has(u.plugin.toLowerCase()) : null,
        credentials: needsByAlias.get(u.alias.toLowerCase()) ?? [],
        hosts: hostsByAlias.get(u.alias.toLowerCase()) ?? [],
      }));

    const declaredRef = isSelf ? null : declaredRefLabel(repo);
    const issues: string[] = [];

    // Activation errors already name these missing selectors.
    const named = new Set((live.missingSelectors ?? []).map((n) => n.toLowerCase()));
    issues.push(
      ...uses
        .filter((u) => u.found === false && !named.has(u.plugin.toLowerCase()))
        .map((u) => `\`${u.plugin}\` is not in this repository's \`exports.plugins\` manifest.`),
    );
    issues.push(...(live.settingsIssues ?? []));
    issues.push(...(live.commandIssues ?? []));
    issues.push(...(live.serviceIssues ?? []));
    if (live.warning) issues.unshift(live.warning);
    for (const w of live.manifestWarnings ?? []) issues.unshift(w);
    if (live.error) issues.unshift(live.error);
    const deduped = [...new Set(issues)];
    issues.length = 0;
    issues.push(...deduped);

    return {
      name: repo.name,
      source: isSelf ? "self" : `${(repo.source as { owner: string }).owner}/${(repo.source as { repo: string }).repo}`,
      // Never pair a live commit with a declaration it may not have come from.
      ref: isSelf ? null : live.commit ? live.ref ?? null : declaredRef,
      commit: live.commit ?? null,
      status: cardStatus(isSelf, live),
      pinned: !isSelf && Boolean(repo.pin),
      uses,
      issues,
      ...(live.depStoreNotice ? { depStoreNotice: live.depStoreNotice } : {}),
    };
  });

  const consumerWarnings = warnings.filter((w) => w.includes("`plugins"));
  const exportWarnings = plugins.declared ? warnings.filter((w) => w.includes("`exports")) : [];

  return {
    declared: plugins.declared,
    pending: false,
    activating: repos.some((r) => r.status === "activating"),
    consumerRepoUrl,
    repos,
    warnings: [...consumerWarnings, ...exportWarnings],
  };
}

function cardStatus(isSelf: boolean, live: PluginRepoRuntime): PluginRepoStatus {
  if (isSelf) return "self";
  if (live.activating) return "activating";
  if (live.commit) return live.error ? "degraded" : "active";
  return "unavailable";
}
