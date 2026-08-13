/**
 * docs/262 — the container half of plugin activation (plan §2).
 *
 * The orchestrator publishes generations under the session state dir and mounts
 * that root into this container twice: read-only at `/plugin-store`, writable at
 * `/plugin-store-rw`. This module turns those mounts into the surface the plan
 * promises the agent, and runs each imported plugin's `install`.
 *
 * **Why install runs here and not in the orchestrator.** An `install` string is
 * authored by whatever repository a project declares. The orchestrator process
 * holds ShipIt's own credentials (the PAT in its git config) and has
 * unrestricted host access, so running that string there is strictly more
 * privileged than `agent.install` — which has always run in this container.
 * Install therefore lands here, with the authority `agent.install` already has,
 * minus the worker token (see {@link installEnv}): third-party plugin code has
 * no business calling this worker's own API.
 *
 * Everything this module needs is readable from disk: the consumer's
 * declaration is in `/workspace/shipit.yaml`, and each plugin's manifest is in
 * its own checkout. So there is no orchestrator→worker payload to keep in sync
 * — the orchestrator only has to say *when*.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  CONTAINER_PLUGINS_DIR,
  CONTAINER_PLUGIN_STORE_DIR,
  CONTAINER_PLUGIN_STORE_RW_DIR,
} from "../shared/fs-constants.js";
import { resolveShipitConfig } from "../shared/shipit-config.js";
import type { PluginExport } from "../shared/plugin-repos.js";
import { WORKER_TOKEN_ENV } from "../shared/worker-auth.js";
import { getErrorMessage } from "../shared/utils.js";

/** ShipIt's own install stamp, written inside the generation it describes. */
const INSTALL_STAMP_FILE = ".shipit-plugin-install.json";

/** A plugin repository's live checkout, as this container sees it. */
interface LiveRepo {
  name: string;
  /** Read-only path the agent is given (`/plugins/<name>` resolves here). */
  roDir: string;
  /** Writable path for install output only. */
  rwDir: string;
  commit: string | null;
}

export interface PluginInstallOutcome {
  repo: string;
  plugin: string;
  alias: string;
  /** `ran` | `skipped` (stamp matched) | `none` (no install declared) | `failed`. */
  status: "ran" | "skipped" | "none" | "failed";
  error?: string;
}

export interface PluginPrepareResult {
  /** Repos that got a `/plugins/<name>` entry. */
  linked: string[];
  /** Declared but with no live generation yet — activation may still be running. */
  missing: string[];
  installs: PluginInstallOutcome[];
}

export interface PreparePluginsOptions {
  workspaceDir: string;
  pluginsDir?: string;
  storeDir?: string;
  storeRwDir?: string;
  /** Injected in tests. Resolves with the command's exit code and a stderr tail. */
  run?: (command: string, cwd: string, env: NodeJS.ProcessEnv) => Promise<{ code: number; stderrTail: string }>;
}

/**
 * Make every live plugin checkout reachable at `/plugins/<name>` and run the
 * imported plugins' installs. Safe to call repeatedly: linking is idempotent and
 * an install whose stamp still matches is skipped.
 *
 * Never throws — a plugin that cannot be prepared is reported, not fatal
 * (req 13: the session opens either way).
 */
export async function preparePlugins(opts: PreparePluginsOptions): Promise<PluginPrepareResult> {
  const pluginsDir = opts.pluginsDir ?? CONTAINER_PLUGINS_DIR;
  const storeDir = opts.storeDir ?? CONTAINER_PLUGIN_STORE_DIR;
  const storeRwDir = opts.storeRwDir ?? CONTAINER_PLUGIN_STORE_RW_DIR;
  const run = opts.run ?? runCommand;
  const result: PluginPrepareResult = { linked: [], missing: [], installs: [] };

  const config = resolveShipitConfig(opts.workspaceDir);
  if (!config.plugins.declared) return result;

  const live = new Map<string, LiveRepo>();
  for (const repo of config.plugins.repos) {
    // `repo: self` runs the live working tree and has no generation (req 27);
    // its consumer-path parity is its own piece of work.
    if (repo.source.kind === "self") continue;

    const roDir = path.join(storeDir, repo.name, "active");
    if (!fs.existsSync(roDir)) {
      result.missing.push(repo.name);
      continue;
    }
    live.set(repo.name.toLowerCase(), {
      name: repo.name,
      roDir,
      rwDir: path.join(storeRwDir, repo.name, "active"),
      commit: readGenerationCommit(roDir),
    });
    if (linkPlugin(pluginsDir, repo.name, roDir)) result.linked.push(repo.name);
  }

  for (const use of config.plugins.uses) {
    const repo = live.get(use.from.toLowerCase());
    if (!repo) continue;
    const manifest = readManifest(repo.roDir, use.plugin);
    if (!manifest) continue;
    result.installs.push(await runInstall(repo, use.plugin, use.alias, manifest, opts.workspaceDir, run));
  }

  return result;
}

/**
 * Point `/plugins/<name>` at the read-only store. The link target is a path
 * that only exists inside this container, and BOTH hops resolve per access —
 * this symlink, then the store's own `active` symlink — so activating a new
 * generation on the host is visible here immediately, with no remount and no
 * container recreation (plan §2 "as built").
 */
function linkPlugin(pluginsDir: string, name: string, target: string): boolean {
  const link = path.join(pluginsDir, name);
  try {
    fs.mkdirSync(pluginsDir, { recursive: true });
    // Replace only what we own. An existing correct link is left alone so a
    // re-prepare mid-turn never briefly breaks a path the agent is using.
    let current: string | null = null;
    try {
      current = fs.readlinkSync(link);
    } catch {
      current = null;
    }
    if (current === target) return true;
    if (current !== null) fs.unlinkSync(link);
    else if (fs.existsSync(link)) return false; // a real file/dir — refuse to clobber
    fs.symlinkSync(target, link);
    return true;
  } catch (err) {
    console.warn(`[plugins] could not link ${link}: ${getErrorMessage(err)}`);
    return false;
  }
}

/** The commit this checkout is, from the record the generation carries. */
function readGenerationCommit(checkoutDir: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(checkoutDir, ".shipit-generation.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    const commit = (parsed as { commit?: unknown }).commit;
    return typeof commit === "string" ? commit : null;
  } catch {
    return null;
  }
}

/** One plugin's manifest entry, read from its own checkout. */
function readManifest(checkoutDir: string, plugin: string): PluginExport | null {
  try {
    const exports = resolveShipitConfig(checkoutDir).pluginExports;
    return exports.find((e) => e.name.toLowerCase() === plugin.toLowerCase()) ?? null;
  } catch {
    return null;
  }
}

async function runInstall(
  repo: LiveRepo,
  plugin: string,
  alias: string,
  manifest: PluginExport,
  workspaceDir: string,
  run: NonNullable<PreparePluginsOptions["run"]>,
): Promise<PluginInstallOutcome> {
  const base = { repo: repo.name, plugin, alias };
  if (!manifest.install) return { ...base, status: "none" };

  const stamp = {
    install: manifest.install,
    commit: repo.commit,
    inputs: hashInputs(repo.roDir, manifest.installInputs),
  };
  if (stampMatches(repo.rwDir, plugin, stamp)) return { ...base, status: "skipped" };

  try {
    // cwd is the checkout root in the WRITABLE view, so `node_modules` and build
    // output land in the generation — a per-session, per-commit directory that
    // is neither the shared bare cache nor the project (req 7).
    const { code, stderrTail } = await run(
      manifest.install,
      repo.rwDir,
      installEnv(repo, workspaceDir),
    );
    if (code !== 0) {
      return { ...base, status: "failed", error: `install exited ${code}${stderrTail ? `: ${stderrTail}` : ""}` };
    }
  } catch (err) {
    return { ...base, status: "failed", error: getErrorMessage(err) };
  }

  writeStamp(repo.rwDir, plugin, stamp);
  return { ...base, status: "ran" };
}

/**
 * The environment a plugin's `install` runs with: what `agent.install` gets,
 * plus the generation's identity, MINUS this worker's own auth token. The token
 * is a capability to call the worker's API; `agent.install` inherits it because
 * it is the project's own command, but a plugin's install string comes from
 * another repository and has no reason to hold it.
 *
 * `SHIPIT_PLUGIN_COMMIT` is deliberately absent when the checkout carries no
 * commit — a live working tree corresponds to no exact commit (req 27), and the
 * fixture uses exactly that to tell its two modes apart.
 */
function installEnv(repo: LiveRepo, workspaceDir: string): NodeJS.ProcessEnv {
  // Built by omission rather than by deleting from a copy: the two names that
  // must not leak are then unset by construction, with no chance of a later
  // edit adding a path that reinstates one.
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === WORKER_TOKEN_ENV || key === "SHIPIT_PLUGIN_COMMIT") continue;
    env[key] = value;
  }
  env.SHIPIT_PROJECT_DIR = workspaceDir;
  if (repo.commit) env.SHIPIT_PLUGIN_COMMIT = repo.commit;
  return env;
}

interface InstallStamp {
  install: string;
  commit: string | null;
  inputs: string | null;
}

/**
 * Content hash of the manifest's `install-inputs`, read through the READ-ONLY
 * view so a previous install's output cannot influence the next decision.
 * Missing files hash as absent rather than failing: the manifest may list a
 * file a later commit removes.
 */
function hashInputs(checkoutDir: string, inputs: readonly string[]): string | null {
  if (inputs.length === 0) return null;
  const hash = crypto.createHash("sha256");
  for (const rel of [...inputs].sort()) {
    hash.update(rel);
    try {
      hash.update(fs.readFileSync(path.join(checkoutDir, rel)));
    } catch {
      hash.update(" absent");
    }
  }
  return hash.digest("hex");
}

function stampPath(checkoutDir: string): string {
  return path.join(checkoutDir, INSTALL_STAMP_FILE);
}

function readStamps(checkoutDir: string): Record<string, InstallStamp> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(stampPath(checkoutDir), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, InstallStamp>) : {};
  } catch {
    return {};
  }
}

function stampMatches(checkoutDir: string, plugin: string, stamp: InstallStamp): boolean {
  const previous = readStamps(checkoutDir)[plugin];
  return (
    !!previous
    && previous.install === stamp.install
    && previous.commit === stamp.commit
    && previous.inputs === stamp.inputs
  );
}

function writeStamp(checkoutDir: string, plugin: string, stamp: InstallStamp): void {
  try {
    const stamps = readStamps(checkoutDir);
    stamps[plugin] = stamp;
    fs.writeFileSync(stampPath(checkoutDir), JSON.stringify(stamps, null, 2));
  } catch (err) {
    // A lost stamp costs a re-run, not correctness.
    console.warn(`[plugins] could not stamp ${plugin}: ${getErrorMessage(err)}`);
  }
}

/** Bounded stderr kept so a failure says why, not just that it failed. */
const STDERR_TAIL_BYTES = 4096;

function runCommand(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number; stderrTail: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, { shell: true, cwd, stdio: ["ignore", "pipe", "pipe"], env });
    let tail = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      tail = (tail + chunk.toString()).slice(-STDERR_TAIL_BYTES);
    });
    proc.stdout?.on("data", (chunk: Buffer) => {
      console.log(`[plugins:install] ${chunk.toString().trimEnd()}`);
    });
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ code: code ?? 1, stderrTail: tail.trim() }));
  });
}
