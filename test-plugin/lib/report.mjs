// docs/262 — the probe report. One builder shared by the CLI (agent container,
// cwd = project workspace) and the service (compose container, /project mount),
// so both execution surfaces verify the same usage contract (plan.md §2) and
// differences between them are visible field-by-field.
//
// Every check degrades to a reported absence rather than a crash: the probe
// must run today, before the plugin feature exists, and report exactly which
// parts of the contract are (not yet) provided.
//
// Building a report NEVER mutates anything observable — reads and writes are
// separate operations, so "run the CLI, then reload the service page" shows
// the same counter. Bumping is explicit: `probe --bump` / POST /increment.

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The plugin's own root (test-plugin/), resolved from this module — verifies
 * that entrypoints are invoked by absolute path (plan §2: CLI wrappers use
 * absolute entrypoints, so relative imports and self-lookups must resolve). */
export const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const INSTALL_STAMP = path.join(PLUGIN_ROOT, ".install-stamp.json");

/**
 * Build the full probe report.
 * @param surface "cli" | "service"
 */
export function buildReport(surface) {
  const env = process.env;
  const activeCommit = env.SHIPIT_PLUGIN_COMMIT ?? null;
  const projectDir = env.SHIPIT_PROJECT_DIR ?? (surface === "service" ? "/project" : process.cwd());
  return {
    surface,
    node: process.version,
    cwd: process.cwd(),
    // The self/consumer discriminator (plan §1a, §2): a consumer generation
    // carries its exact commit; `repo: self` runs the live working tree, which
    // corresponds to no exact commit, so the env stays unset.
    mode: activeCommit ? "consumer-generation" : "self-or-unprovided",
    env: {
      // req 21 / plan §2 — the workspace handle.
      SHIPIT_PROJECT_DIR: env.SHIPIT_PROJECT_DIR ?? null,
      // req 15 — the exact commit the running generation was built from.
      SHIPIT_PLUGIN_COMMIT: activeCommit,
      // reqs 17, 18 — the per-session shared state directory.
      SHIPIT_PLUGIN_STATE: env.SHIPIT_PLUGIN_STATE ?? null,
      // req 26 — path to the validated settings JSON.
      SHIPIT_SETTINGS: env.SHIPIT_SETTINGS ?? null,
    },
    // req 23 — presence only; the probe never prints a credential value.
    credential: { name: "PROBE_TOKEN", set: typeof env.PROBE_TOKEN === "string" && env.PROBE_TOKEN.length > 0 },
    settings: readSettings(env.SHIPIT_SETTINGS),
    project: checkProject(projectDir),
    // req 27 — the working tree's own dependencies, from the plugin's side.
    dependency: checkDependency(projectDir),
    state: checkState(surface, env.SHIPIT_PLUGIN_STATE),
    checkout: checkCheckoutWritable(),
    install: checkInstallStamp(activeCommit),
  };
}

/** Resolve the state dir for this surface (plan §2: /plugin-state in service
 * containers, SHIPIT_PLUGIN_STATE on both surfaces). */
export function stateDir(surface, stateDirEnv = process.env.SHIPIT_PLUGIN_STATE) {
  return stateDirEnv ?? (surface === "service" ? "/plugin-state" : null);
}

/**
 * reqs 17, 18 — explicitly bump the shared counter. The counter is the byte
 * length of an append-only file: a one-byte O_APPEND write is atomic, so
 * concurrent CLI/service bumps never lose increments. Returns the new count,
 * or null when no state dir is provided.
 */
export function bumpCounter(surface) {
  const dir = stateDir(surface);
  if (!dir) return null;
  const bumpsFile = path.join(dir, "bumps");
  fs.appendFileSync(bumpsFile, "1");
  return fs.statSync(bumpsFile).size;
}

/** req 26 — parse the settings file; report the `greeting` value or the failure. */
function readSettings(settingsPath) {
  if (!settingsPath) return { provided: false };
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    return { provided: true, path: settingsPath, greeting: parsed?.greeting ?? null };
  } catch (err) {
    return { provided: true, path: settingsPath, error: String(err instanceof Error ? err.message : err) };
  }
}

/** req 21 — can this surface see the consuming project's files? */
function checkProject(dir) {
  try {
    const entries = fs.readdirSync(dir);
    return { dir, readable: true, entries: entries.length };
  } catch {
    return { dir, readable: false };
  }
}

/** The package the dependency check loads — an ordinary runtime dependency of
 * this repository, chosen because it is small, pure JavaScript and used by the
 * server, so it is present in any tree `agent.install` has prepared. */
const PROBE_DEPENDENCY = "yaml";

/**
 * req 27 — can the plugin's own code load a dependency out of a `node_modules`?
 * **This is the check the fixture was missing**, and its absence is why two real
 * end-to-end runs passed while self-use was broken: every other export here
 * imports `node:` built-ins and one relative file, so nothing in the fixture
 * could tell a populated `node_modules` from an empty one
 * (nikzlabs/shipit#2298).
 *
 * Reported per ROOT rather than once, because `/plugin` and `/project` are two
 * separate mounts even where they are one tree. Under `repo: self` the CLI's
 * entry point executes out of `/plugin` while its cwd is `/project`, so a single
 * answer for "the dependency works" would call a half-restored regression fixed.
 *
 * Resolution WALKS UP from the root given, exactly as an ordinary `import` in
 * that file would, so `plugin` is a real test of the `/plugin` mount even though
 * `PLUGIN_ROOT` is `test-plugin/` inside it rather than the repository root.
 * On the SERVICE surface `PLUGIN_ROOT` is `/app` — this fragment's own
 * directory, mounted on its own — and nothing is reachable above it; that root
 * is expected to report `resolved: false` there, and README.md says so.
 *
 * Loaded with `createRequire` rather than a static `import` so a missing
 * dependency is a REPORTED field and not an `ERR_MODULE_NOT_FOUND` traceback
 * from a process that never printed a report.
 */
function checkDependency(projectDir) {
  return {
    package: PROBE_DEPENDENCY,
    // What the self-use contract promises: the repository's own `agent.install`
    // prepares the working tree "that the services and CLIs then run out of".
    // Under a consumer generation this root is somebody else's repository and
    // has no reason to carry the package, so `resolved: false` is expected.
    project: resolveFrom(projectDir),
    // The plugin's own tree: its `install` output for a consumer generation, and
    // the same working tree as `project` under `repo: self`.
    plugin: resolveFrom(PLUGIN_ROOT),
  };
}

/**
 * One root's answer. `used` goes one step past resolution: a `node_modules`
 * mounted from the wrong layer can leave a package directory that resolves and
 * then fails to load.
 */
function resolveFrom(root) {
  try {
    const require = createRequire(path.join(root, "probe-resolution-root.mjs"));
    const entry = require.resolve(PROBE_DEPENDENCY);
    const loaded = require(PROBE_DEPENDENCY);
    return {
      root,
      resolved: true,
      entry,
      version: readDependencyVersion(require),
      used: loaded.parse("probe: ok\n")?.probe === "ok",
    };
  } catch (err) {
    return {
      root,
      resolved: false,
      error: String(err instanceof Error ? err.message : err),
    };
  }
}

/** Best effort — a package whose `package.json` is not exported still counts as
 * resolved, so this reports `null` rather than failing the whole check. */
function readDependencyVersion(require) {
  try {
    return require(`${PROBE_DEPENDENCY}/package.json`).version ?? null;
  } catch {
    return null;
  }
}

/**
 * reqs 17, 18 — shared state between the CLI and the service. Read-only:
 * reports the current counter and whether the dir accepts writes (via a
 * touch-and-delete test file, never the counter itself).
 */
function checkState(surface, stateDirEnv) {
  const dir = stateDir(surface, stateDirEnv);
  if (!dir) return { provided: false };
  try {
    const testFile = path.join(dir, ".state-write-test");
    fs.writeFileSync(testFile, "x");
    fs.unlinkSync(testFile);
    let counter = 0;
    try {
      counter = fs.statSync(path.join(dir, "bumps")).size;
    } catch {
      // No bumps yet this session.
    }
    return { provided: true, dir, writable: true, counter };
  } catch (err) {
    return { provided: true, dir, writable: false, error: String(err instanceof Error ? err.message : err) };
  }
}

/**
 * Raw observation of this surface's own mount — still NOT the self/consumer
 * discriminator (use `mode` / `env.SHIPIT_PLUGIN_COMMIT`), but since
 * 2026-08-15 it is a direct check of the rule ShipIt now states: **`/plugin`
 * is writable exactly when it is the project** (plan §2). So on the CLI
 * surface, whose PLUGIN_ROOT is `/plugin`, a consumer generation reports
 * `false` and a `repo: self` working tree reports `true`.
 *
 * On the SERVICE surface PLUGIN_ROOT is `/app` — this fragment's own
 * `- .:/app:ro`. That mount is the plugin author's, but ShipIt now FORCES it
 * read-only for a tracked generation (a fragment's relative mounts are rewritten
 * onto the same volume, and Compose's default is read-write), so a consumer
 * service reports `false` whether or not the author wrote `:ro`. Under
 * `repo: self` the declared mode is kept, so dropping the `:ro` here would
 * report `true`.
 *
 * (An earlier revision of this comment read the two surfaces' disagreement as
 * by-design. It was not: the CLI mount and the tracked fragment mount were both
 * writable, and both are now fixed.)
 */
function checkCheckoutWritable() {
  const probeFile = path.join(PLUGIN_ROOT, ".probe-write-test");
  try {
    fs.writeFileSync(probeFile, "probe");
    fs.unlinkSync(probeFile);
    return { root: PLUGIN_ROOT, writable: true };
  } catch {
    return { root: PLUGIN_ROOT, writable: false };
  }
}

/** req 7 — did `install` run for the active generation? (install.mjs writes the
 * stamp with the generation env — plan §1b.) `matchesActiveCommit` is null
 * when there is no active commit (self-use: no generations to match). */
function checkInstallStamp(activeCommit) {
  try {
    const stamp = JSON.parse(fs.readFileSync(INSTALL_STAMP, "utf-8"));
    return {
      found: true,
      commit: stamp.commit ?? null,
      matchesActiveCommit: activeCommit === null ? null : stamp.commit === activeCommit,
    };
  } catch {
    return { found: false };
  }
}
