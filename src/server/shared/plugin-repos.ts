/**
 * docs/262 — plugin repositories: the consumer `plugins:` block and the
 * plugin-side `exports.plugins:` manifest (plan §1a/§1b), plus the browser
 * snapshot types behind `GET /api/plugin-repos`.
 *
 * Filesystem-free on purpose (the `declared-tracker.ts` precedent): the client
 * imports the types, so nothing here may pull in `node:fs`. The parser is pure
 * — `shipit-config.ts` feeds it the raw YAML value and the declared trackers.
 *
 * Parsing is **phase 1** of the three validation phases (plan §1a): grammar,
 * the repo-name/tracker-name reservation pass, alias uniqueness, and reference
 * shape — everything knowable without a network. Selector validation against a
 * *fetched* manifest is phase 2; service/command collisions are phase 3. Like
 * the trackers block, **nothing here is fatal** (req 13): every malformed
 * entry warns and is dropped, and the session still opens.
 */

import { parseOwnerRepo } from "./tracker-id.js";
import type { DeclaredTracker } from "./declared-tracker.js";

// ---------------------------------------------------------------------------
// Config types (what shipit.yaml declares)
// ---------------------------------------------------------------------------

/** Where a declared plugin repo's content comes from. */
export type PluginRepoSource =
  | { kind: "github"; owner: string; repo: string }
  | { kind: "self" };

/** One `plugins.repos` entry (plan §1a): one checkout, one card, one refresh unit. */
export interface DeclaredPluginRepo {
  /** The reservation-domain name: checkout path, card, refresh target, feedback destination. */
  name: string;
  source: PluginRepoSource;
  /** Tracked branch; mutually exclusive with `pin`; never present for `self`. */
  branch?: string;
  /** Tag or SHA; mutually exclusive with `branch`; never present for `self`. */
  pin?: string;
}

/** Per-service consumer override (req 16, req 20). */
export interface PluginServiceOverride {
  autostart?: boolean;
  /** Service alias on collision. */
  as?: string;
}

/** Consumer overrides on one `use` entry — flat: the entry IS one plugin. */
export interface PluginUseOverrides {
  services: Record<string, PluginServiceOverride>;
  commands: Record<string, { as?: string }>;
  /** req 26 — values for plugin-declared settings. Scalars only. */
  settings: Record<string, string | number | boolean>;
}

/** One `plugins.use` entry: activates one exported plugin from a declared repo. */
export interface PluginUse {
  /** Selector: the exported plugin to activate (validated against the manifest in phase 2). */
  plugin: string;
  /** References a declared repo by name. */
  from: string;
  /** Local name; defaults to `plugin`. Keys overrides/settings/skills namespacing and UI. */
  alias: string;
  overrides: PluginUseOverrides;
}

/** The parsed consumer block. `declared` is plugin INTENT — the key existing at
 * all — which is what gates the Plugins tab (req 13: an invalid declaration
 * must not erase its own warning surface). */
export interface PluginReposConfig {
  declared: boolean;
  repos: DeclaredPluginRepo[];
  uses: PluginUse[];
}

/** One exported plugin from the manifest (plan §1b). All fields optional —
 * a CLI-only or files-only export is valid. */
export interface PluginExport {
  name: string;
  /** Compose fragment path, relative to the repo root. */
  compose?: string;
  /** Command name → entrypoint path (repo-root-relative). */
  cli: Record<string, string>;
  /** Skills directory, relative to the repo root. */
  skills?: string;
  install?: string;
  /** Files whose content re-triggers install (same convention as agent.install-inputs). */
  installInputs: string[];
  /** Credential NAMES only — values live with each consuming project (req 23). */
  credentials: string[];
  /** Informational; grants nothing (req 24). */
  hosts: string[];
  /** Declared settings + defaults (req 26). */
  settings: Record<string, { description?: string; default?: string | number | boolean }>;
}

export const EMPTY_PLUGIN_REPOS: Readonly<PluginReposConfig> = Object.freeze({
  declared: false,
  repos: [],
  uses: [],
});

// ---------------------------------------------------------------------------
// Snapshot types (what GET /api/plugin-repos returns)
// ---------------------------------------------------------------------------

/** One `use` entry as the card shows it. `found` is three-valued: resolved
 * against a manifest (self repos — theirs is in the same file), missing from
 * that manifest, or `null` = not knowable until the repo is fetched. */
export interface PluginRepoUseView {
  plugin: string;
  alias: string;
  found: boolean | null;
}

/**
 * One card in the Plugins tab. v0 statuses, honest about what exists:
 * - `"self"` — the live working tree (req 27); no ref/commit by design.
 * - `"declared"` — a tracked repo whose checkout/generation mechanics are not
 *   built yet. Deliberately NOT an error state and NOT counted toward the warn
 *   dot: the design's never-fetched state means "tried and failed", which is
 *   not what "the feature is still being built" is. The full state set
 *   (active/degraded/collision/unavailable) arrives with the slice-2 mechanics.
 */
export interface PluginRepoCardView {
  name: string;
  /** `"self"` or `"owner/repo"` — always visible on the card (req 19). */
  source: string;
  /** `branch @ …` / `pin @ …` display source; null for self. */
  ref: string | null;
  /** Exact commit once generations exist; null until then and for self. */
  commit: string | null;
  status: "self" | "declared";
  uses: PluginRepoUseView[];
  /** Problems attached to this repo (e.g. a self selector missing from the manifest). */
  issues: string[];
}

export interface PluginReposSnapshot {
  /** Plugin intent — gates the tab. */
  declared: boolean;
  /** The consuming project's remote — the secret store "Add key…" must write to (plan §3). */
  consumerRepoUrl: string | null;
  repos: PluginRepoCardView[];
  /** Parse-level warnings (dropped entries, unknown keys). Count toward the warn dot. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Parsing — consumer side
// ---------------------------------------------------------------------------

/** Same charset as tracker names: the shared reservation domain (plan §1a
 * phase 1) needs one rule, and aliases feed the `plugins--<alias>--<skill>`
 * namespace, so whitespace/`#`/`/` are out for both. */
const PLUGIN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const KNOWN_REPO_KEYS = new Set(["repo", "name", "branch", "pin"]);
const KNOWN_USE_KEYS = new Set(["plugin", "from", "alias", "overrides"]);
const KNOWN_OVERRIDE_KEYS = new Set(["services", "commands", "settings"]);
const KNOWN_SERVICE_OVERRIDE_KEYS = new Set(["autostart", "as"]);
const KNOWN_COMMAND_OVERRIDE_KEYS = new Set(["as"]);

function isMapping(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isScalar(v: unknown): v is string | number | boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/**
 * Parse the consumer `plugins:` block. `trackers` feeds the cross-block name
 * reservation: tracker names are reserved first (they parse first), and a repo
 * name colliding with one is dropped — UNLESS the repo's GitHub destination is
 * the same repository the tracker already points at, which is the sanctioned
 * alias case (plan §1a: one destination, two names, one adapter).
 */
export function parsePluginRepos(
  raw: unknown,
  trackers: readonly DeclaredTracker[],
  warnings: string[],
): PluginReposConfig {
  if (raw === undefined || raw === null) return { ...EMPTY_PLUGIN_REPOS };

  if (!isMapping(raw)) {
    warnings.push("`plugins` must be a mapping (object); ignoring it.");
    // The key exists, so intent is declared — the tab must show the warning.
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
    // Reservation pass, cross-block half: trackers parse first, so on a name
    // collision the tracker wins — except when the plugin repo IS the
    // tracker's repository, where one destination legitimately carries both
    // roles under one name.
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

function destinationKey(source: PluginRepoSource): string {
  return source.kind === "self" ? "self" : `${source.owner}/${source.repo}`.toLowerCase();
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
    // req 27 — the session's own working tree: live, no version to track.
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

/** A tri-state string field: undefined (absent), the trimmed value, or `false`
 * meaning "present but unusable" — the entry is dropped so a typo'd pin can't
 * silently become "track the default branch". */
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
        warnings.push(`Unknown key \`plugins.use[${i}].${key}\` in shipit.yaml.`);
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
    // Domain 2 of the naming phases: aliases are unique across ALL use
    // entries — the alias keys settings, skills namespacing, and the UI.
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

function parseOverrides(
  raw: unknown,
  useIndex: number,
  warnings: string[],
): PluginUseOverrides | null {
  const empty: PluginUseOverrides = { services: {}, commands: {}, settings: {} };
  if (raw === undefined || raw === null) return empty;
  if (!isMapping(raw)) {
    warnings.push(`Ignoring \`plugins.use[${useIndex}]\`: \`overrides\` must be a mapping.`);
    return null;
  }

  for (const key of Object.keys(raw)) {
    if (!KNOWN_OVERRIDE_KEYS.has(key)) {
      warnings.push(`Unknown key \`plugins.use[${useIndex}].overrides.${key}\` in shipit.yaml.`);
    }
  }

  const services: Record<string, PluginServiceOverride> = {};
  if (raw.services !== undefined && raw.services !== null) {
    if (!isMapping(raw.services)) {
      warnings.push(`Ignoring \`plugins.use[${useIndex}].overrides.services\`: must be a mapping keyed by service name.`);
    } else {
      for (const [svc, val] of Object.entries(raw.services)) {
        if (!isMapping(val)) {
          warnings.push(`Ignoring \`plugins.use[${useIndex}].overrides.services.${svc}\`: must be a mapping.`);
          continue;
        }
        const out: PluginServiceOverride = {};
        for (const key of Object.keys(val)) {
          if (!KNOWN_SERVICE_OVERRIDE_KEYS.has(key)) {
            warnings.push(`Unknown key \`plugins.use[${useIndex}].overrides.services.${svc}.${key}\` in shipit.yaml.`);
          }
        }
        if (val.autostart !== undefined) {
          if (typeof val.autostart !== "boolean") {
            warnings.push(`Ignoring \`…services.${svc}.autostart\`: must be true or false.`);
          } else {
            out.autostart = val.autostart;
          }
        }
        const as = parseAlias(val.as, `plugins.use[${useIndex}].overrides.services.${svc}.as`, warnings);
        if (as) out.as = as;
        services[svc] = out;
      }
    }
  }

  const commands: Record<string, { as?: string }> = {};
  if (raw.commands !== undefined && raw.commands !== null) {
    if (!isMapping(raw.commands)) {
      warnings.push(`Ignoring \`plugins.use[${useIndex}].overrides.commands\`: must be a mapping keyed by command name.`);
    } else {
      for (const [cmd, val] of Object.entries(raw.commands)) {
        if (!isMapping(val)) {
          warnings.push(`Ignoring \`plugins.use[${useIndex}].overrides.commands.${cmd}\`: must be a mapping.`);
          continue;
        }
        for (const key of Object.keys(val)) {
          if (!KNOWN_COMMAND_OVERRIDE_KEYS.has(key)) {
            warnings.push(`Unknown key \`plugins.use[${useIndex}].overrides.commands.${cmd}.${key}\` in shipit.yaml.`);
          }
        }
        const out: { as?: string } = {};
        const as = parseAlias(val.as, `plugins.use[${useIndex}].overrides.commands.${cmd}.as`, warnings);
        if (as) out.as = as;
        commands[cmd] = out;
      }
    }
  }

  const settings: Record<string, string | number | boolean> = {};
  if (raw.settings !== undefined && raw.settings !== null) {
    if (!isMapping(raw.settings)) {
      warnings.push(`Ignoring \`plugins.use[${useIndex}].overrides.settings\`: must be a mapping.`);
    } else {
      for (const [name, val] of Object.entries(raw.settings)) {
        // Fail-closed grammar (plan §1a): setting values are scalars.
        if (!isScalar(val)) {
          warnings.push(`Ignoring \`plugins.use[${useIndex}].overrides.settings.${name}\`: setting values must be scalars.`);
          continue;
        }
        settings[name] = val;
      }
    }
  }

  return { services, commands, settings };
}

function parseAlias(raw: unknown, label: string, warnings: string[]): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || !PLUGIN_NAME_RE.test(raw.trim())) {
    warnings.push(`Ignoring \`${label}\`: an alias must be letters, digits, \`.\`, \`_\` or \`-\`.`);
    return undefined;
  }
  return raw.trim();
}

// ---------------------------------------------------------------------------
// Parsing — plugin side (the exports manifest)
// ---------------------------------------------------------------------------

const KNOWN_EXPORT_KEYS = new Set([
  "compose",
  "cli",
  "skills",
  "install",
  "install-inputs",
  "credentials",
  "hosts",
  "settings",
]);

/** Credential names are environment variable names (req 23). */
const CREDENTIAL_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/** A hostname, no scheme, no path — `fal.run`, not `https://fal.run/x` (req 24). */
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

/**
 * Parse the `exports:` block. Fail-closed **per plugin** (plan §1b): a plugin
 * entry with any invalid field is dropped whole, with a warning naming the
 * field — degraded beats partial (reqs 13, 14). Phase 2 turns that same rule
 * into "a failing selected export invalidates the repository's generation".
 */
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
  const drop = (reason: string): null => {
    warnings.push(`Ignoring exported plugin \`${name}\`: ${reason}.`);
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

  const credentials: string[] = [];
  if (entry.credentials !== undefined && entry.credentials !== null) {
    if (!Array.isArray(entry.credentials)) return drop("`credentials` must be a list of credential NAMES");
    for (const c of entry.credentials) {
      if (typeof c !== "string" || !CREDENTIAL_NAME_RE.test(c)) {
        return drop(`credential names must look like environment variables (got \`${String(c)}\`)`);
      }
      credentials.push(c);
    }
  }

  const hosts: string[] = [];
  if (entry.hosts !== undefined && entry.hosts !== null) {
    if (!Array.isArray(entry.hosts)) return drop("`hosts` must be a list of hostnames");
    for (const h of entry.hosts) {
      if (typeof h !== "string" || !HOST_RE.test(h)) {
        return drop(`hosts must be bare hostnames like \`fal.run\` (got \`${String(h)}\`)`);
      }
      hosts.push(h);
    }
  }

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
    credentials,
    hosts,
    settings,
  };
}

/** Literal relative path, workspace-confined — the same structural rules as
 * `agent.dep-dirs`, re-implemented here because this module must stay
 * filesystem-free (the shipit-config helper lives beside `node:fs` imports).
 * Returns the normalized path, `undefined` for absent, or `{error}` — the
 * caller drops the whole plugin (fail-closed per plugin). */
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

// ---------------------------------------------------------------------------
// Snapshot assembly (used by the /api/plugin-repos route)
// ---------------------------------------------------------------------------

/**
 * Project the parsed config into the browser snapshot. Pure — the route feeds
 * it the config and the session's remote. Self repos resolve their `use`
 * selectors against the same file's own manifest (their phase 2 needs no
 * fetch); tracked repos stay `found: null` until checkout mechanics exist.
 */
export function buildPluginReposSnapshot(
  plugins: PluginReposConfig,
  pluginExports: readonly PluginExport[],
  consumerRepoUrl: string | null,
  warnings: readonly string[],
): PluginReposSnapshot {
  const exportNames = new Set(pluginExports.map((e) => e.name.toLowerCase()));

  const repos: PluginRepoCardView[] = plugins.repos.map((repo) => {
    const isSelf = repo.source.kind === "self";
    const uses = plugins.uses
      .filter((u) => u.from.toLowerCase() === repo.name.toLowerCase())
      .map((u) => ({
        plugin: u.plugin,
        alias: u.alias,
        found: isSelf ? exportNames.has(u.plugin.toLowerCase()) : null,
      }));
    const issues = uses
      .filter((u) => u.found === false)
      .map((u) => `\`${u.plugin}\` is not in this repository's \`exports.plugins\` manifest.`);
    return {
      name: repo.name,
      source: repo.source.kind === "self" ? "self" : `${repo.source.owner}/${repo.source.repo}`,
      ref: isSelf ? null : repo.pin ?? repo.branch ?? "default branch",
      commit: null,
      status: isSelf ? ("self" as const) : ("declared" as const),
      uses,
      issues,
    };
  });

  return {
    declared: plugins.declared,
    consumerRepoUrl,
    repos,
    warnings: warnings.filter((w) => w.includes("plugins") || w.includes("exports")),
  };
}
