// docs/262 — the probe report. One builder shared by the CLI (agent container,
// cwd = project workspace) and the service (compose container, /project mount),
// so both execution surfaces verify the same usage contract (plan.md §2) and
// differences between them are visible field-by-field.
//
// Every check degrades to a reported absence rather than a crash: the probe
// must run today, before the plugin feature exists, and report exactly which
// parts of the contract are (not yet) provided.

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
    // req 7 — the checkout is read-only for a consumer, live (writable) under
    // `repo: self`. This field is where the two fixtures must differ.
    checkout: checkCheckoutWritable(),
    install: checkInstallStamp(activeCommit),
  };
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
 * reqs 17, 18 — shared state between the CLI and the service. Every probe
 * increments one counter file, so running the CLI and reloading the service
 * page against the same session must show one monotonically shared number.
 */
function checkState(surface, stateDirEnv) {
  const dir = stateDirEnv ?? (surface === "service" ? "/plugin-state" : null);
  if (!dir) return { provided: false };
  const counterFile = path.join(dir, "counter.json");
  try {
    let count = 0;
    try {
      count = Number(JSON.parse(fs.readFileSync(counterFile, "utf-8")).count) || 0;
    } catch {
      // First probe of the session — the counter starts at 0.
    }
    count += 1;
    fs.writeFileSync(counterFile, JSON.stringify({ count, lastSurface: surface, at: new Date().toISOString() }));
    return { provided: true, dir, writable: true, counter: count };
  } catch (err) {
    return { provided: true, dir, writable: false, error: String(err instanceof Error ? err.message : err) };
  }
}

/** req 7 — attempt (and clean up) a write inside the plugin's own tree. */
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

/** req 7 — did `install` run for the active generation? (install.mjs writes the stamp) */
function checkInstallStamp(activeCommit) {
  try {
    const stamp = JSON.parse(fs.readFileSync(INSTALL_STAMP, "utf-8"));
    return {
      found: true,
      commit: stamp.commit ?? null,
      matchesActiveCommit: activeCommit !== null && stamp.commit === activeCommit,
    };
  } catch {
    return { found: false };
  }
}
