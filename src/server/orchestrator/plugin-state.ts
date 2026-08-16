/**
 * docs/262 reqs 17, 18, 26 — the two things every **imported plugin** gets in a
 * consuming session, keyed by its `alias`: a **shared state directory** and a
 * **validated settings file**.
 *
 * They are the primitives, not their consumers. Mounting them into plugin
 * service containers and naming them in a CLI invocation are later slices; the
 * names those slices use are fixed in `shared/plugin-contract.ts`. What lives
 * here is: where these things sit on disk, when they are created, what
 * "validated" means for a setting, and what a refresh may and may not throw
 * away.
 *
 * ## Layout, and why it is NOT under the state dir
 *
 *   <sessionDir>/plugin-data/<alias>/state/         → SHIPIT_PLUGIN_STATE
 *   <sessionDir>/plugin-data/<alias>/settings.json  → SHIPIT_SETTINGS
 *
 * The obvious home was `<sessionDir>/state/` (docs/246), beside the plugin
 * checkouts — and it is wrong for this data. That whole subtree is in
 * `REGENERABLE_SESSION_SUBDIRS` (`disk-utils.ts`): disk-tier eviction and
 * archive delete it, precisely because everything in it can be rebuilt. A
 * plugin's shared state cannot be rebuilt, and req 18 says it survives
 * everything short of the session being reset or deleted. So it goes where the
 * other durable, non-git session data goes — a sibling of `workspace/`, the
 * `uploads/` convention (docs/217, planning#182), which the reclaim allowlist
 * deliberately leaves alone. Full reset and a session-directory delete still
 * take it, which is exactly req 18's "discarded only when the session itself is
 * reset or deleted".
 *
 * It is equally not inside the checkout: `<state>/plugins/` is mounted READ-ONLY
 * into the agent container as the plugin store, and generation pruning owns
 * everything under it — a state directory there would be both unwritable and
 * deleted by the next refresh (reqs 7, 12).
 *
 * The settings file sits BESIDE the state directory rather than inside it. The
 * state directory is writable by plugin code; a plugin that can rewrite its own
 * validated settings has settings that were never validated.
 *
 * ## Keyed by alias, not by plugin or repository
 *
 * The `alias` is what the consumer declaration names an import by, it is unique
 * across all `use:` entries (phase 1), and it already keys settings and skills
 * namespacing. Two `use:` entries of the same plugin therefore get two state
 * directories, which is what "each imported plugin" means — they are separate
 * imports with separate settings.
 *
 * ## What a refresh may throw away
 *
 * Nothing in the state directory (req 18 names refresh explicitly). The settings
 * file is the opposite: it is derived from the declaration and the live
 * manifest, so it is rewritten on every round and removed when it can no longer
 * be trusted. A dropped `use:` entry loses its settings file and KEEPS its state
 * directory — undeclaring an import is not one of the two things req 18 allows
 * to discard state, and re-adding it must find what was there.
 */

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

/** Durable per-session root holding one directory per imported plugin. */
export const PLUGIN_DATA_SUBDIR = "plugin-data";
/** The plugin-writable half of an import's directory. */
export const PLUGIN_STATE_SUBDIR = "state";
/** The validated settings file, beside (never inside) the state dir. */
export const PLUGIN_SETTINGS_FILE = "settings.json";

/**
 * What may be used as a path segment here. The parser already guarantees it
 * (`PLUGIN_NAME_RE`), so this is not validation of user input — it is a refusal
 * to build a path out of anything that has not been through the parser, since
 * every value below becomes a directory name.
 */
const SAFE_ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * The session root, from the session's clone path — resolved through the
 * validated state-dir resolver rather than a bare `dirname`, so an unrecognized
 * session layout fails here instead of returning a path that is wrong for every
 * caller (planning#288).
 */
export function sessionRootForWorkspace(workspaceDir: string): string {
  return path.dirname(sessionStateDirForWorkspace(workspaceDir));
}

export function pluginDataRoot(sessionDir: string): string {
  return path.join(sessionDir, PLUGIN_DATA_SUBDIR);
}

export function pluginDataDir(sessionDir: string, alias: string): string {
  return path.join(pluginDataRoot(sessionDir), alias);
}

/** Host path of an imported plugin's shared state directory (reqs 17, 18). */
export function pluginStateDir(sessionDir: string, alias: string): string {
  return path.join(pluginDataDir(sessionDir, alias), PLUGIN_STATE_SUBDIR);
}

/** Host path of an imported plugin's validated settings file (req 26). */
export function pluginSettingsPath(sessionDir: string, alias: string): string {
  return path.join(pluginDataDir(sessionDir, alias), PLUGIN_SETTINGS_FILE);
}

/**
 * A session path as the DAEMON can reach it: the subpath, inside the volume
 * rooted at `volumeRoot`, that names it — or `null` when it cannot be named that
 * way.
 *
 * **Every path this file produces is orchestrator-visible only.** In production
 * the whole session tree lives inside a named volume; the daemon has no path for
 * it, so handing one of these to Docker as a bind source creates an empty,
 * root-owned directory where the data was meant to be — and dev and dogfood,
 * where the paths are real, look perfect the entire time. The established
 * translation is a volume mount with `VolumeOptions.Subpath`
 * (`container-lifecycle.ts` for the agent container, `compose-generator.ts` for
 * service containers); this is that translation, in the one place both plugin
 * surfaces take it from, so the CLI container and a plugin service cannot derive
 * it two different ways.
 *
 * `null` covers the two shapes with no honest answer: a path outside the volume
 * (nothing in it to point at) and the volume ROOT itself (whose subpath would be
 * "", i.e. every session's tree at once). Callers must fail closed on it —
 * refuse the run, drop the service with a reason — never fall back to a bind,
 * which is the defect this exists to remove.
 */
export function volumeSubpathFor(volumeRoot: string, hostPath: string): string | null {
  const root = volumeRoot.replace(/\/+$/, "");
  if (!root) return null;
  const rel = path.relative(root, hostPath);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  // Compose and the Docker API both want POSIX separators inside a volume.
  return rel.split(path.sep).join("/");
}

// ---------------------------------------------------------------------------
// Settings resolution (req 26)
// ---------------------------------------------------------------------------

/** A setting value, as both sides of the edge may write it. */
export type PluginSettingValue = string | number | boolean;

export interface ResolvedPluginSettings {
  /** The values the plugin will see, defaults applied. Only declared names. */
  values: Record<string, PluginSettingValue>;
  /**
   * Why no settings file can be written. Reported per import and surfaced on
   * the plugin card; a plugin with errors gets NO settings file rather than a
   * partial one.
   */
  errors: string[];
}

/**
 * Resolve one import's settings: the plugin's declared settings, with the
 * consuming project's values applied over the plugin's defaults (req 26).
 *
 * Pure, so the API route can report exactly what the writer would write without
 * writing anything.
 *
 * Two things are **errors**, not silent degradations, both for the reason the
 * parser gives for its own fail-closed grammar: a settings value that does not
 * take effect is indistinguishable, from inside the plugin, from one that was
 * never set — and req 26's example setting is *the directory a plugin writes
 * the project's durable output into*. Getting that silently wrong writes real
 * files to the wrong place.
 *
 *  - **A value for a setting the plugin does not declare.** Usually a typo or a
 *    plugin that renamed a setting; either way the project asked for something
 *    and would have got the default without being told.
 *  - **A value whose type disagrees with the declared default.** The default is
 *    the only type information the manifest carries, so it is the only check
 *    available — and a plugin reading `settings.port` as a number does not want
 *    the string `"8080"`. A setting with no default has no declared type, and
 *    any scalar is accepted.
 *  - **A number YAML can write but JSON cannot carry.** `.nan`, `.inf` and
 *    `1e999` all parse as ordinary numbers and pass every check above, and
 *    `JSON.stringify` then writes them as `null` — so the plugin would receive
 *    neither the declared value nor a number, with nothing reported (review
 *    finding). Both sides are checked: a consumer's value and the plugin's own
 *    default.
 *
 * A declared setting with neither a value nor a default is **omitted** from the
 * result rather than emitted as null: the manifest has no "required" concept,
 * so an absent optional setting is the plugin's own business.
 */
export function resolvePluginSettings(
  exported: PluginExport,
  use: PluginUse,
): ResolvedPluginSettings {
  const declared = exported.settings;
  const provided = use.overrides.settings;
  // Null-prototype: both maps are YAML the consumer and the plugin wrote, and
  // this object is serialized straight to JSON.
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

/**
 * Whether a value survives the round trip through the settings file. Only
 * numbers can fail: YAML has `.nan`/`.inf` and accepts an overflowing literal,
 * JSON has neither, and `JSON.stringify` turns all three into `null`.
 */
function isRepresentable(value: PluginSettingValue): boolean {
  return typeof value !== "number" || Number.isFinite(value);
}

function typeName(value: PluginSettingValue): string {
  return typeof value === "number" ? "a number" : typeof value === "boolean" ? "true or false" : "a string";
}

// ---------------------------------------------------------------------------
// Manifest lookup
// ---------------------------------------------------------------------------

/** Resolves what one `use:` entry points at: its repository, and its manifest entry. */
export interface PluginImportResolver {
  /**
   * The declared repository's OWN spelling, or null when `from:` names none.
   *
   * Both halves need this and neither may use `use.from` directly: `from:`
   * matches case-insensitively, while the checkout directory and the Plugins
   * card are both keyed by the declaration's spelling. Using the `use` entry's
   * spelling silently finds nothing on a case-sensitive filesystem — the defect
   * `plugin-runtime.ts` had to fix.
   */
  repoNameFor: (use: PluginUse) => string | null;
  /**
   * The manifest entry behind the import, or null when it is not knowable — an
   * unknown repository, or one with no live generation. `null` is deliberately
   * different from "declares no such setting": the caller leaves an existing
   * settings file alone, because the absence of a manifest is not evidence that
   * the settings in it are wrong.
   */
  exportFor: (use: PluginUse) => PluginExport | null;
}

/**
 * Build the resolver for one operation: a `repo: self` import reads the
 * project's own `exports.plugins` (already parsed — its manifest is the same
 * file), and a tracked import reads the manifest out of the generation
 * directory `live` already resolved and verified.
 *
 * It takes the resolved generations rather than a `stateDir` on purpose
 * (docs/262 resolve-once): given a state dir it would follow `active` itself,
 * and every other reader answering for the same card would follow it again — so
 * one request could describe one repository with a commit from generation A and
 * settings validated against B's manifest. Taking a verified handle also means
 * this cannot read a generation belonging to a repository the declaration no
 * longer names; the check lives where the link was resolved.
 */
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
            // req 27 — a self repo's manifest IS this same file, already parsed.
            ? [...selfExports]
            // Read out of the directory this operation already resolved and
            // verified. No live generation — including one belonging to a
            // repository this declaration no longer names — collapses to "no
            // exports", which the caller reads as "nothing to validate
            // against" either way.
            : manifestOf(live(repo)),
        );
      }
      return cache.get(key)!.find((e) => e.name.toLowerCase() === use.plugin.toLowerCase()) ?? null;
    },
  };
}

/** The manifest of a verified generation, or none when nothing is live. */
function manifestOf(verified: VerifiedGeneration | null): PluginExport[] {
  return verified ? readGenerationManifestAt(verified.dir) : [];
}

// ---------------------------------------------------------------------------
// Preparation
// ---------------------------------------------------------------------------

/** One import's primitives, after a prepare pass. */
export interface PluginStateEntry {
  alias: string;
  /** The declaring repository's own spelling — the unit the card groups by. */
  repo: string | null;
  /** Host path of the shared state directory (created unless it says otherwise). */
  stateDir: string;
  /** Host path of the settings file, or null when none is currently valid. */
  settingsPath: string | null;
  /**
   * Why the settings could not be resolved (req 26). Recomputable from the
   * declaration and the live manifest, which is why the snapshot GET derives
   * them itself rather than reading them from a round that may never have run.
   */
  issues: string[];
  /**
   * Why this attempt could not put the primitives on disk — a directory that
   * could not be created, a settings file that could not be written or handed
   * to the worker uid.
   *
   * Deliberately NOT in `issues`: nothing can recompute it, so the only way it
   * reaches the card is by being remembered from the attempt that hit it
   * (review finding — a failed write was logged and nowhere else, so a plugin
   * kept running on the settings from before the edit).
   */
  failure?: string;
}

export interface PreparePluginStateOptions {
  /** The session ROOT (`<sessionsRoot>/<id>`), not its clone and not its state dir. */
  sessionDir: string;
  uses: readonly PluginUse[];
  resolver: PluginImportResolver;
}

/**
 * Make every imported plugin's state directory and settings file current.
 *
 * Idempotent and safe to run on every activation round: an existing state
 * directory is left exactly as it is (req 18), and the settings file is
 * rewritten from the declaration plus the live manifest.
 *
 * Never throws — a plugin whose primitives cannot be prepared reports an issue,
 * and the session opens either way (req 13).
 */
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

    // The state directory first, and independent of the manifest: it belongs to
    // the import, not to whatever version of the plugin is live right now, so a
    // repository that has not been fetched yet must not cost the session its
    // state (req 18 — it survives everything short of a reset).
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      // The orchestrator is root; plugin services and CLI containers run as the
      // session-worker uid, and a root-owned state dir is a read-only one to
      // them. No-op when the non-root runtime is off.
      //
      // ONLY the state dir. Its parent stays root-owned, because deleting or
      // replacing a file is governed by the directory's permissions, not the
      // file's — handing the parent over would let anything running as the
      // worker uid swap the validated settings file sitting in it, whatever
      // mode that file has. Traversal is all the worker needs there.
      chownToSessionWorker(stateDir);
      // And CHECK it. The chown helper is best-effort by design (every caller
      // in this repo treats a failure as a warning), but here a failed handoff
      // means the one writable surface a plugin has is not writable — which
      // would surface as an inscrutable EACCES inside third-party code rather
      // than as a problem with the session (review finding).
      // docs/270 — ask the SAME resolver the chown just used. Comparing against
      // the one global uid would now fail for every session that has an
      // identity of its own, turning a successful handoff into a plugin failure.
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
    // No manifest to validate against (nothing activated yet, or the export is
    // gone). Any settings file already there stays: it was written from a
    // manifest, and not having one right now is not evidence that it is wrong.
    if (!exported) continue;

    const resolved = resolvePluginSettings(exported, use);
    if (resolved.errors.length > 0) {
      entry.issues.push(...resolved.errors);
      // Fail closed: a stale file from an earlier, valid declaration would let
      // the plugin run on settings the project has since changed.
      removeQuietly(settingsPath);
      continue;
    }

    try {
      writeSettingsFile(settingsPath, resolved.values);
      entry.settingsPath = settingsPath;
    } catch (err) {
      // Fail closed here too, and for the same reason: what is on disk is the
      // PREVIOUS declaration's values, and leaving it readable is how a plugin
      // keeps writing the project's durable output to the directory the project
      // has since moved away from (review finding).
      removeQuietly(settingsPath);
      entry.failure = `\`${use.alias}\`: its settings file could not be written: ${message(err)}`;
    }
  }

  sweepUndeclaredSettings(opts.sessionDir, aliases);
  return entries;
}

/**
 * Write the settings file atomically, then make it read-only.
 *
 * Atomic because a plugin service may be reading it while a refresh rewrites
 * it, and half a JSON document is a parse error rather than an old value. The
 * mode is belt-and-braces on top of mounting it read-only: nothing that runs as
 * the worker uid should be able to edit what ShipIt validated.
 *
 * **Unchanged content is not rewritten**, and that is not just tidiness. A
 * prepare pass runs on every activation round — every session activation and
 * every `shipit.yaml` edit — while an atomic write replaces the file with a new
 * inode, and a Docker **file** bind mount follows the inode it was created
 * with. Churning it on every round would leave a long-lived service container
 * holding a file nothing writes to any more. Skipping the no-op write means the
 * inode only ever changes when the settings genuinely did, which is also when
 * the mount slice has to recreate the service anyway (plan §2).
 */
function writeSettingsFile(settingsPath: string, values: Record<string, PluginSettingValue>): void {
  const content = `${JSON.stringify(values, null, 2)}\n`;
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

/**
 * Drop settings files for imports the declaration no longer names — and ONLY
 * those files.
 *
 * The asymmetry is req 18's: a settings file is derived config, so an
 * un-imported one is stale by definition, while the state directory beside it
 * is data the session is only allowed to lose on reset or delete. So an import
 * removed from `shipit.yaml` and added back finds its state where it left it,
 * with freshly validated settings.
 */
function sweepUndeclaredSettings(sessionDir: string, aliases: ReadonlySet<string>): void {
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(pluginDataRoot(sessionDir), { withFileTypes: true });
  } catch {
    return; // no imports yet — nothing to sweep
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
    // Best-effort: the caller's report already says what state it is in.
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * Settings problems, grouped by the declared repository the import came from —
 * the unit the Plugins tab draws a card for (plan §3).
 *
 * Computed from the declaration and the live manifests rather than remembered
 * from the last prepare, so the snapshot GET stays a pure read: it reports
 * exactly what a prepare would refuse to write, and it does so even before the
 * first round has run (req 13 — a declaration that cannot work says so).
 *
 * **A `Map`, not an object keyed by repository name.** `constructor`, `toString`
 * and `hasOwnProperty` are all valid declared names under the parser's grammar,
 * and on a plain object every one of them reads back as an inherited function
 * for a repository that has no issues at all — truthy, `.length` non-zero, and
 * fatal at the first spread (review finding: it turned a valid declaration into
 * "shipit.yaml could not be parsed").
 */
export function pluginSettingsIssuesByRepo(
  plugins: PluginReposConfig,
  selfExports: readonly PluginExport[],
  live: LiveGenerations,
): Map<string, string[]> {
  const resolver = createPluginImportResolver(plugins, selfExports, live);
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
