import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type DeclaredPluginRepo,
  type PluginExport,
  type PluginReposConfig,
  type PluginUse,
} from "../shared/plugin-repos.js";
import {
  readGenerationManifestAt,
  type LiveGenerations,
  type VerifiedGeneration,
} from "./plugin-generations.js";
import { chownToSessionWorker, identityForTarget } from "./session-worker-uid.js";
import { sessionStateDirForWorkspace } from "./session-state-dir.js";

// Keep durable plugin data outside the regenerable session state directory.
export const PLUGIN_DATA_SUBDIR = "plugin-data";
export const PLUGIN_STATE_SUBDIR = "state";
export const PLUGIN_SETTINGS_FILE = "settings.json";

const SAFE_ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function sessionRootForWorkspace(workspaceDir: string): string {
  return path.dirname(sessionStateDirForWorkspace(workspaceDir));
}

export function pluginDataRoot(sessionDir: string): string {
  return path.join(sessionDir, PLUGIN_DATA_SUBDIR);
}

export function pluginDataDir(sessionDir: string, alias: string): string {
  return path.join(pluginDataRoot(sessionDir), alias);
}

export function pluginStateDir(sessionDir: string, alias: string): string {
  return path.join(pluginDataDir(sessionDir, alias), PLUGIN_STATE_SUBDIR);
}

export function pluginSettingsPath(sessionDir: string, alias: string): string {
  return path.join(pluginDataDir(sessionDir, alias), PLUGIN_SETTINGS_FILE);
}

// A null result must not fall back to a bind: the daemon cannot see orchestrator paths.
export function volumeSubpathFor(volumeRoot: string, hostPath: string): string | null {
  const root = volumeRoot.replace(/\/+$/, "");
  if (!root) return null;
  const rel = path.relative(root, hostPath);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

export type PluginSettingValue = string | number | boolean;

export interface ResolvedPluginSettings {
  values: Record<string, PluginSettingValue>;
  errors: string[];
}

export function resolvePluginSettings(
  exported: PluginExport,
  use: PluginUse,
): ResolvedPluginSettings {
  const declared = exported.settings;
  const provided = use.overrides.settings;
  const values: Record<string, PluginSettingValue> = Object.create(null) as Record<string, PluginSettingValue>;
  const errors: string[] = [];

  for (const [name, decl] of Object.entries(declared)) {
    if (!has(provided, name)) {
      if (decl.default === undefined) continue;
      if (!isRepresentable(decl.default)) {
        errors.push(`\`${use.alias}\`: the plugin's default for \`${name}\` is not a number JSON can carry.`);
        continue;
      }
      values[name] = decl.default;
      continue;
    }
    const value = provided[name];
    if (decl.default !== undefined && typeof value !== typeof decl.default) {
      errors.push(
        `\`${use.alias}\`: setting \`${name}\` must be ${typeName(decl.default)} `
        + `(the plugin's default is \`${String(decl.default)}\`), but this project sets ${typeName(value)}.`,
      );
      continue;
    }
    if (!isRepresentable(value)) {
      errors.push(
        `\`${use.alias}\`: setting \`${name}\` is \`${String(value)}\`, which is not a number JSON can carry.`,
      );
      continue;
    }
    values[name] = value;
  }

  for (const name of Object.keys(provided)) {
    if (has(declared, name)) continue;
    errors.push(
      `\`${use.alias}\`: \`${name}\` is not a setting \`${exported.name}\` declares, `
      + "so the value this project sets would have no effect.",
    );
  }

  return { values, errors };
}

function has(map: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(map, key);
}

// JSON turns YAML's NaN and infinite numbers into null.
function isRepresentable(value: PluginSettingValue): boolean {
  return typeof value !== "number" || Number.isFinite(value);
}

function typeName(value: PluginSettingValue): string {
  return typeof value === "number" ? "a number" : typeof value === "boolean" ? "true or false" : "a string";
}

export interface PluginImportResolver {
  // Use the declaration's spelling for paths; from matches without case sensitivity.
  repoNameFor: (use: PluginUse) => string | null;
  exportFor: (use: PluginUse) => PluginExport | null;
}

// Reuse verified generation handles so one request cannot mix manifests across a refresh.
export function createPluginImportResolver(
  plugins: PluginReposConfig,
  selfExports: readonly PluginExport[],
  live: LiveGenerations,
): PluginImportResolver {
  const declaredRepos = new Map(plugins.repos.map((r) => [r.name.toLowerCase(), r]));
  const cache = new Map<string, PluginExport[]>();

  const repoFor = (use: PluginUse): DeclaredPluginRepo | undefined =>
    declaredRepos.get(use.from.toLowerCase());

  return {
    repoNameFor: (use) => repoFor(use)?.name ?? null,
    exportFor: (use) => {
      const repo = repoFor(use);
      if (!repo) return null;
      const key = repo.name.toLowerCase();
      if (!cache.has(key)) {
        cache.set(
          key,
          repo.source.kind === "self"
            ? [...selfExports]
            : manifestOf(live(repo)),
        );
      }
      return cache.get(key)!.find((e) => e.name.toLowerCase() === use.plugin.toLowerCase()) ?? null;
    },
  };
}

function manifestOf(verified: VerifiedGeneration | null): PluginExport[] {
  return verified ? readGenerationManifestAt(verified.dir) : [];
}

export interface PluginStateEntry {
  alias: string;
  repo: string | null;
  stateDir: string;
  settingsPath: string | null;
  issues: string[];
  // Disk failures must be retained; unlike validation issues, GET cannot recompute them.
  failure?: string;
}

export interface PreparePluginStateOptions {
  sessionDir: string;
  uses: readonly PluginUse[];
  resolver: PluginImportResolver;
}

export function preparePluginState(opts: PreparePluginStateOptions): PluginStateEntry[] {
  const entries: PluginStateEntry[] = [];
  const aliases = new Set<string>();

  for (const use of opts.uses) {
    if (!SAFE_ALIAS_RE.test(use.alias)) continue;
    aliases.add(use.alias);

    const stateDir = pluginStateDir(opts.sessionDir, use.alias);
    const settingsPath = pluginSettingsPath(opts.sessionDir, use.alias);
    const entry: PluginStateEntry = {
      alias: use.alias,
      repo: opts.resolver.repoNameFor(use),
      stateDir,
      settingsPath: null,
      issues: [],
    };
    entries.push(entry);

    try {
      fs.mkdirSync(stateDir, { recursive: true });
      // Keep the parent root-owned so plugin code cannot replace validated settings.
      chownToSessionWorker(stateDir);
      // chown is best-effort; verify with the same per-session identity resolver.
      const owner = identityForTarget(stateDir);
      if (owner !== null && fs.statSync(stateDir).uid !== owner.uid) {
        entry.failure = `\`${use.alias}\`: its shared state directory could not be handed to the session user.`;
        continue;
      }
    } catch (err) {
      entry.failure = `\`${use.alias}\`: its shared state directory could not be created: ${message(err)}`;
      continue;
    }

    const exported = opts.resolver.exportFor(use);
    // An unavailable manifest is not evidence that existing settings are invalid.
    if (!exported) continue;

    const resolved = resolvePluginSettings(exported, use);
    if (resolved.errors.length > 0) {
      entry.issues.push(...resolved.errors);
      removeQuietly(settingsPath);
      continue;
    }

    try {
      writeSettingsFile(settingsPath, resolved.values);
      entry.settingsPath = settingsPath;
    } catch (err) {
      // Remove stale settings so the plugin cannot use the previous declaration.
      removeQuietly(settingsPath);
      entry.failure = `\`${use.alias}\`: its settings file could not be written: ${message(err)}`;
    }
  }

  sweepUndeclaredSettings(opts.sessionDir, aliases);
  return entries;
}

function writeSettingsFile(settingsPath: string, values: Record<string, PluginSettingValue>): void {
  const content = `${JSON.stringify(values, null, 2)}\n`;
  // File bind mounts retain the old inode. Replace it only when settings change.
  if (readQuietly(settingsPath) === content) return;

  const tmp = `${settingsPath}.tmp-${crypto.randomUUID().slice(0, 8)}`;
  try {
    fs.writeFileSync(tmp, content, { mode: 0o444 });
    fs.renameSync(tmp, settingsPath);
  } catch (err) {
    removeQuietly(tmp);
    throw err;
  }
}

function readQuietly(target: string): string | null {
  try {
    return fs.readFileSync(target, "utf-8");
  } catch {
    return null;
  }
}

// Removing an import discards derived settings, but retains its durable state.
function sweepUndeclaredSettings(sessionDir: string, aliases: ReadonlySet<string>): void {
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(pluginDataRoot(sessionDir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory() || aliases.has(dir.name)) continue;
    removeQuietly(pluginSettingsPath(sessionDir, dir.name));
  }
}

function removeQuietly(target: string): void {
  try {
    fs.rmSync(target, { force: true });
  } catch {
    // Best-effort cleanup.
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function pluginSettingsIssuesByRepo(
  plugins: PluginReposConfig,
  selfExports: readonly PluginExport[],
  live: LiveGenerations,
): Map<string, string[]> {
  const resolver = createPluginImportResolver(plugins, selfExports, live);
  // Valid repository names include Object prototype keys such as constructor.
  const byRepo = new Map<string, string[]>();

  for (const use of plugins.uses) {
    const exported = resolver.exportFor(use);
    if (!exported) continue;
    const { errors } = resolvePluginSettings(exported, use);
    if (errors.length === 0) continue;
    const repoName = resolver.repoNameFor(use) ?? use.from;
    byRepo.set(repoName, [...(byRepo.get(repoName) ?? []), ...errors]);
  }
  return byRepo;
}
