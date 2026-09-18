import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const INSTALL_STAMP = path.join(PLUGIN_ROOT, ".install-stamp.json");

/** @param surface "cli" | "service" */
export function buildReport(surface) {
  const env = process.env;
  const activeCommit = env.SHIPIT_PLUGIN_COMMIT ?? null;
  const projectDir = env.SHIPIT_PROJECT_DIR ?? (surface === "service" ? "/project" : process.cwd());
  return {
    surface,
    node: process.version,
    cwd: process.cwd(),
    mode: activeCommit ? "consumer-generation" : "self-or-unprovided",
    env: {
      SHIPIT_PROJECT_DIR: env.SHIPIT_PROJECT_DIR ?? null,
      SHIPIT_PLUGIN_COMMIT: activeCommit,
      SHIPIT_PLUGIN_STATE: env.SHIPIT_PLUGIN_STATE ?? null,
      SHIPIT_SETTINGS: env.SHIPIT_SETTINGS ?? null,
    },
    credential: { name: "PROBE_TOKEN", set: typeof env.PROBE_TOKEN === "string" && env.PROBE_TOKEN.length > 0 },
    settings: readSettings(env.SHIPIT_SETTINGS),
    project: checkProject(projectDir),
    dependency: checkDependency(projectDir),
    state: checkState(surface, env.SHIPIT_PLUGIN_STATE),
    checkout: checkCheckoutWritable(),
    install: checkInstallStamp(activeCommit),
  };
}

export function stateDir(surface, stateDirEnv = process.env.SHIPIT_PLUGIN_STATE) {
  return stateDirEnv ?? (surface === "service" ? "/plugin-state" : null);
}

// One-byte O_APPEND writes keep concurrent CLI and service increments atomic.
export function bumpCounter(surface) {
  const dir = stateDir(surface);
  if (!dir) return null;
  const bumpsFile = path.join(dir, "bumps");
  fs.appendFileSync(bumpsFile, "1");
  return fs.statSync(bumpsFile).size;
}

function readSettings(settingsPath) {
  if (!settingsPath) return { provided: false };
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    return { provided: true, path: settingsPath, greeting: parsed?.greeting ?? null };
  } catch (err) {
    return { provided: true, path: settingsPath, error: String(err instanceof Error ? err.message : err) };
  }
}

function checkProject(dir) {
  try {
    const entries = fs.readdirSync(dir);
    return { dir, readable: true, entries: entries.length };
  } catch {
    return { dir, readable: false };
  }
}

const PROBE_DEPENDENCY = "yaml";

// Check both mounts; resolving from /project does not prove /plugin has its dependencies.
function checkDependency(projectDir) {
  return {
    package: PROBE_DEPENDENCY,
    project: resolveFrom(projectDir),
    plugin: resolveFrom(PLUGIN_ROOT),
  };
}

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

function readDependencyVersion(require) {
  try {
    return require(`${PROBE_DEPENDENCY}/package.json`).version ?? null;
  } catch {
    return null;
  }
}

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
      // No bumps yet.
    }
    return { provided: true, dir, writable: true, counter };
  } catch (err) {
    return { provided: true, dir, writable: false, error: String(err instanceof Error ? err.message : err) };
  }
}

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
