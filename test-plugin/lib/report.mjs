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
    project: checkProject(surface, env.SHIPIT_PROJECT_DIR),
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
function checkProject(surface, projectDirEnv) {
  const dir = projectDirEnv ?? (surface === "service" ? "/project" : process.cwd());
  try {
    const entries = fs.readdirSync(dir);
    return { dir, readable: true, entries: entries.length };
  } catch {
    return { dir, readable: false };
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
 * Raw observation of this surface's own mount — NOT the self/consumer
 * discriminator. A consumer CLI runs through the plugin's writable layer
 * (plan §1b: install output must be visible), so its writes succeed there
 * too; and the compose fragment mounts the plugin read-only into the service
 * in both modes. Discriminate the fixtures via `mode` /
 * `env.SHIPIT_PLUGIN_COMMIT` instead. That layer writes never reach the
 * underlying checkout is a slice-2 guard test — unobservable from in here.
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
