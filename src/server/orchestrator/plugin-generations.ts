/**
 * docs/262 — plugin **generations**: turning a declared plugin repository into
 * an activated, exact-commit checkout on disk (plan §2 "Refresh is generation
 * activation", reqs 7, 8, 12, 15).
 *
 * A generation is the unit req 15 makes coherent: one repository, one exact
 * commit, one parsed manifest, one completed install. Activation is
 * **stage → validate → install → publish**, and only the last step is visible:
 *
 *   <state>/plugins/<repo-name>/generations/<sha>/     the checkout
 *   <state>/plugins/<repo-name>/generations/<sha>.json the generation record
 *   <state>/plugins/<repo-name>/active                 symlink → the live one
 *   <state>/plugins/pins.json                          durable pin resolutions
 *
 * Publishing is a symlink rename, which is atomic on POSIX: a reader either
 * sees the whole old generation or the whole new one, never a half-installed
 * tree. Any failure before that leaves the previous generation active and
 * whole — "degraded beats partial" (reqs 13, 15).
 *
 * **Where it lives is load-bearing.** Generations sit in the session STATE dir
 * (docs/246), a sibling of the clone, so the post-turn `git add -A` can never
 * stage a plugin checkout into the user's repository.
 *
 * **The writable layer is the generation directory itself.** The plan called
 * for a copy-on-write layer over a read-only checkout; a per-session,
 * per-commit, disposable directory already gives install output a home that
 * pollutes neither the shared bare cache nor the project, so the extra layer
 * would buy nothing here. Read-only for the *agent* is enforced where it is
 * enforceable — the `:ro` bind mount, which lands with the container wiring.
 *
 * **Fetching is orchestrator-side** (req 19): this module runs in the
 * orchestrator and reaches git credentials; plugin code never does.
 */

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import simpleGit from "simple-git";
import { parse as parseYaml } from "yaml";
import type { DeclaredPluginRepo, PluginExport } from "../shared/plugin-repos.js";
import { parsePluginExports } from "../shared/plugin-repos.js";

/** Subdirectory of the session state dir that holds every plugin checkout. */
export const PLUGINS_SUBDIR = "plugins";

/** How long a plugin's `install` command may run before it is killed. */
const INSTALL_TIMEOUT_MS = 10 * 60_000;

/** A 40-hex object name — a `pin` in this shape needs no ref resolution. */
const SHA_RE = /^[0-9a-f]{40}$/i;

/** The record written beside each generation directory. */
export interface GenerationRecord {
  repoName: string;
  /** The exact commit this generation was built from (req 15). */
  commit: string;
  /** What the consumer declared: `branch: main`, `pin: v1.2.0`, … */
  ref: string;
  /** ISO timestamp of activation. */
  activatedAt: string;
  /** Exported plugin names found in the manifest (phase-2 selector input). */
  exports: string[];
  /** Install stamp — absent when the manifest declares no install. */
  installStamp?: string;
}

/** What `activateGeneration` did. */
export type ActivationOutcome =
  | { status: "unchanged"; generation: GenerationRecord }
  | { status: "activated"; generation: GenerationRecord }
  | {
      /**
       * Nothing was activated. `previous` — when present — is still whole and
       * live: req 15's "the prior version remains active".
       */
      status: "failed";
      reason: string;
      previous?: GenerationRecord;
    };

export interface ActivateDeps {
  /** The session's state dir (`sessionStateDir(sessionDir)`). */
  stateDir: string;
  /** Bare cache directory for this plugin repository. */
  bareCacheDir: string;
  /** Clone URL, credentials embedded by the caller if the repo is private. */
  repoUrl: string;
  /** Ensure the bare cache exists and is current. Injected so tests stay offline. */
  ensureCache: (cacheDir: string, repoUrl: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function pluginsRoot(stateDir: string): string {
  return path.join(stateDir, PLUGINS_SUBDIR);
}

function repoRoot(stateDir: string, repoName: string): string {
  return path.join(pluginsRoot(stateDir), repoName);
}

function generationsRoot(stateDir: string, repoName: string): string {
  return path.join(repoRoot(stateDir, repoName), "generations");
}

function generationDir(stateDir: string, repoName: string, commit: string): string {
  return path.join(generationsRoot(stateDir, repoName), commit);
}

function generationRecordPath(stateDir: string, repoName: string, commit: string): string {
  return path.join(generationsRoot(stateDir, repoName), `${commit}.json`);
}

/** The symlink every reader follows — the only name that names "live". */
export function activeLinkPath(stateDir: string, repoName: string): string {
  return path.join(repoRoot(stateDir, repoName), "active");
}

/**
 * The active generation's record, or null when nothing is activated. Reads
 * through the symlink, so it reports what is actually live rather than what
 * was last written.
 */
export function readActiveGeneration(stateDir: string, repoName: string): GenerationRecord | null {
  try {
    const target = fs.readlinkSync(activeLinkPath(stateDir, repoName));
    const commit = path.basename(target);
    const raw = fs.readFileSync(generationRecordPath(stateDir, repoName, commit), "utf-8");
    return JSON.parse(raw) as GenerationRecord;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pin durability (req 8)
// ---------------------------------------------------------------------------

interface PinFile {
  /** declaration key → resolved SHA. */
  pins: Record<string, string>;
}

function pinFilePath(stateDir: string): string {
  return path.join(pluginsRoot(stateDir), "pins.json");
}

/**
 * The key a pin resolution is recorded under: the declaration, not the repo.
 * Editing the declaration is what re-resolves (req 8), so the declaration has
 * to be part of the identity.
 */
function pinKey(repo: DeclaredPluginRepo): string {
  const source = repo.source.kind === "self" ? "self" : `${repo.source.owner}/${repo.source.repo}`;
  return `${repo.name}|${source}|${repo.pin ?? ""}`;
}

function readPins(stateDir: string): PinFile {
  try {
    return JSON.parse(fs.readFileSync(pinFilePath(stateDir), "utf-8")) as PinFile;
  } catch {
    return { pins: {} };
  }
}

function writePin(stateDir: string, key: string, commit: string): void {
  const file = readPins(stateDir);
  file.pins[key] = commit;
  fs.mkdirSync(pluginsRoot(stateDir), { recursive: true });
  fs.writeFileSync(pinFilePath(stateDir), JSON.stringify(file, null, 2));
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

/** Serializes activation per (state dir, repo) so two triggers can't stage the same repo twice. */
const inFlight = new Map<string, Promise<ActivationOutcome>>();

/**
 * Bring `repo` to its declared version, activating a new generation when the
 * resolved commit differs from the live one.
 *
 * Never throws: every failure resolves to `{status: "failed"}` with the prior
 * generation left active (req 13 — a session opens even when a plugin repo
 * cannot be fetched).
 */
export async function activateGeneration(
  repo: DeclaredPluginRepo,
  deps: ActivateDeps,
): Promise<ActivationOutcome> {
  if (repo.source.kind === "self") {
    // req 27 — the live working tree is the "checkout"; there is nothing to
    // stage, and no commit to be coherent with. Callers use the session's own
    // workspace directly.
    return { status: "failed", reason: "`repo: self` has no generations — it runs the live working tree" };
  }

  const key = `${deps.stateDir}::${repo.name}`;
  const running = inFlight.get(key);
  if (running) return running;

  const task = activateOnce(repo, deps).finally(() => inFlight.delete(key));
  inFlight.set(key, task);
  return task;
}

async function activateOnce(repo: DeclaredPluginRepo, deps: ActivateDeps): Promise<ActivationOutcome> {
  const { stateDir, bareCacheDir, repoUrl } = deps;
  const previous = readActiveGeneration(stateDir, repo.name) ?? undefined;
  const declaredRef = repo.pin ? `pin ${repo.pin}` : `branch ${repo.branch ?? "(default)"}`;

  try {
    await deps.ensureCache(bareCacheDir, repoUrl);
  } catch (err) {
    return { status: "failed", reason: `could not fetch ${repoUrl}: ${message(err)}`, ...(previous ? { previous } : {}) };
  }

  let commit: string;
  try {
    commit = await resolveCommit(repo, stateDir, bareCacheDir);
  } catch (err) {
    return { status: "failed", reason: message(err), ...(previous ? { previous } : {}) };
  }

  // Already live, and its install is still valid for its stamped inputs.
  if (previous?.commit === commit) {
    const record = await refreshIfInstallStale(repo, stateDir, previous);
    return { status: "unchanged", generation: record };
  }

  const finalDir = generationDir(stateDir, repo.name, commit);
  const stagingDir = `${finalDir}.staging-${crypto.randomUUID().slice(0, 8)}`;

  try {
    await fsp.mkdir(generationsRoot(stateDir, repo.name), { recursive: true });
    await checkoutCommit(bareCacheDir, stagingDir, commit);

    const exports = readManifest(stagingDir);
    const installStamp = await runInstall(stagingDir, exports, commit);

    // Publish. The rename is what makes the generation exist; everything
    // before it wrote only to a name nothing reads.
    await fsp.rm(finalDir, { recursive: true, force: true });
    await fsp.rename(stagingDir, finalDir);

    const record: GenerationRecord = {
      repoName: repo.name,
      commit,
      ref: declaredRef,
      activatedAt: new Date().toISOString(),
      exports: exports.map((e) => e.name),
      ...(installStamp ? { installStamp } : {}),
    };
    await fsp.writeFile(generationRecordPath(stateDir, repo.name, commit), JSON.stringify(record, null, 2));
    await swapActiveLink(stateDir, repo.name, commit);
    await pruneOldGenerations(stateDir, repo.name, commit);

    console.log(`[plugins] ${repo.name}: activated ${commit.slice(0, 9)} (${declaredRef})`);
    return { status: "activated", generation: record };
  } catch (err) {
    await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    return { status: "failed", reason: message(err), ...(previous ? { previous } : {}) };
  }
}

/**
 * Resolve the declared version to an exact commit.
 *
 * A `pin` is durable (req 8): the first resolution is recorded against the
 * declaration and reused forever after, so a **moved tag does not move the
 * plugin** — it warns instead. Only editing the declaration re-resolves.
 */
async function resolveCommit(
  repo: DeclaredPluginRepo,
  stateDir: string,
  bareCacheDir: string,
): Promise<string> {
  const git = simpleGit(bareCacheDir);

  if (repo.pin) {
    if (SHA_RE.test(repo.pin)) return repo.pin.toLowerCase();

    const key = pinKey(repo);
    const recorded = readPins(stateDir).pins[key];
    const resolved = (await git.raw(["rev-parse", `${repo.pin}^{commit}`])).trim();
    if (recorded && recorded !== resolved) {
      console.warn(
        `[plugins] ${repo.name}: tag ${repo.pin} now points at ${resolved.slice(0, 9)} but this project `
          + `is pinned to ${recorded.slice(0, 9)} — edit the declaration to move it.`,
      );
      return recorded;
    }
    if (!recorded) writePin(stateDir, key, resolved);
    return resolved;
  }

  const branch = repo.branch ?? (await defaultBranch(bareCacheDir));
  return (await git.raw(["rev-parse", `${branch}^{commit}`])).trim();
}

async function defaultBranch(bareCacheDir: string): Promise<string> {
  const head = (await simpleGit(bareCacheDir).raw(["symbolic-ref", "--short", "HEAD"])).trim();
  return head || "main";
}

/** Materialize `commit` into `targetDir` from the bare cache (hardlinked objects). */
async function checkoutCommit(bareCacheDir: string, targetDir: string, commit: string): Promise<void> {
  await simpleGit().raw(["clone", "--local", "--no-checkout", bareCacheDir, targetDir]);
  const git = simpleGit(targetDir);
  await git.raw(["config", "gc.auto", "0"]);
  await git.raw(["checkout", "--detach", commit]);
}

/**
 * Parse the plugin repository's own `shipit.yaml`. A repository with no
 * manifest is not an error — req 2 gives its *files* to the session either
 * way; it simply exports nothing.
 */
function readManifest(checkoutDir: string): PluginExport[] {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(checkoutDir, "shipit.yaml"), "utf-8");
  } catch {
    return [];
  }
  const warnings: string[] = [];
  const doc: unknown = parseYaml(raw);
  const exportsBlock = doc && typeof doc === "object" && !Array.isArray(doc)
    ? (doc as Record<string, unknown>).exports
    : undefined;
  const parsed = parsePluginExports(exportsBlock, warnings);
  for (const w of warnings) console.warn(`[plugins] ${checkoutDir}: ${w}`);
  return parsed;
}

/**
 * Run every exported plugin's `install`, with cwd = the checkout root and the
 * generation's env (plan §1b). Returns the stamp for the inputs that were
 * installed, so an unchanged commit doesn't re-install.
 */
async function runInstall(
  checkoutDir: string,
  exportsList: readonly PluginExport[],
  commit: string,
): Promise<string | undefined> {
  const withInstall = exportsList.filter((e) => e.install);
  if (withInstall.length === 0) return undefined;

  for (const entry of withInstall) {
    await runCommand(entry.install!, checkoutDir, commit);
  }
  return installStampFor(checkoutDir, withInstall, commit);
}

/**
 * The install stamp: the plugin commit, every install string, and the CONTENT
 * of each declared `install-inputs` file (plan §1b — the convention
 * `agent.install-inputs` already uses). A change in any of them re-installs.
 */
function installStampFor(
  checkoutDir: string,
  exportsList: readonly PluginExport[],
  commit: string,
): string {
  const hash = crypto.createHash("sha256");
  hash.update(commit);
  for (const entry of exportsList) {
    hash.update(`\0${entry.name}\0${entry.install ?? ""}`);
    for (const input of entry.installInputs) {
      try {
        hash.update(fs.readFileSync(path.join(checkoutDir, input)));
      } catch {
        hash.update("\0missing");
      }
    }
  }
  return hash.digest("hex");
}

/**
 * Re-run install for an already-live generation whose stamped inputs changed.
 * The commit is identical, so there is nothing to stage or swap — only the
 * install layer is stale (req 7).
 */
async function refreshIfInstallStale(
  repo: DeclaredPluginRepo,
  stateDir: string,
  record: GenerationRecord,
): Promise<GenerationRecord> {
  const dir = generationDir(stateDir, repo.name, record.commit);
  const exportsList = readManifest(dir).filter((e) => e.install);
  if (exportsList.length === 0) return record;

  const expected = installStampFor(dir, exportsList, record.commit);
  if (expected === record.installStamp) return record;

  try {
    for (const entry of exportsList) {
      await runCommand(entry.install!, dir, record.commit);
    }
    const updated: GenerationRecord = {
      ...record,
      installStamp: installStampFor(dir, exportsList, record.commit),
    };
    await fsp.writeFile(
      generationRecordPath(stateDir, repo.name, record.commit),
      JSON.stringify(updated, null, 2),
    );
    return updated;
  } catch (err) {
    console.warn(`[plugins] ${repo.name}: install re-run failed (keeping the generation): ${message(err)}`);
    return record;
  }
}

/**
 * Atomic publish: write the new symlink under a temporary name, then rename
 * it over the old one. `rename(2)` on a symlink is atomic, so a concurrent
 * reader never observes a missing `active`.
 */
async function swapActiveLink(stateDir: string, repoName: string, commit: string): Promise<void> {
  const link = activeLinkPath(stateDir, repoName);
  const tmp = `${link}.tmp-${crypto.randomUUID().slice(0, 8)}`;
  await fsp.symlink(path.join("generations", commit), tmp);
  await fsp.rename(tmp, link);
}

/** Keep only the live generation; the rest are disposable rebuild-from-cache copies. */
async function pruneOldGenerations(stateDir: string, repoName: string, keepCommit: string): Promise<void> {
  const root = generationsRoot(stateDir, repoName);
  let entries: string[];
  try {
    entries = await fsp.readdir(root);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((name) => name !== keepCommit && name !== `${keepCommit}.json`)
      // Never touch a staging directory: a concurrent activation owns it.
      .filter((name) => !name.includes(".staging-"))
      .map((name) => fsp.rm(path.join(root, name), { recursive: true, force: true }).catch(() => undefined)),
  );
}

/** Run one install command through a shell, bounded and non-inheriting. */
function runCommand(command: string, cwd: string, commit: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env, SHIPIT_PLUGIN_COMMIT: commit },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`install command timed out after ${INSTALL_TIMEOUT_MS / 1000}s: ${command}`));
    }, INSTALL_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`install command failed (exit ${code}): ${command}\n${stderr.slice(-500)}`));
    });
  });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
