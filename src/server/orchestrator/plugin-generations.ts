/**
 * docs/262 — plugin **generations**: turning a declared plugin repository into
 * an activated, exact-commit checkout on disk (plan §2 "Refresh is generation
 * activation", reqs 8, 12, 13, 14, 15).
 *
 * A generation is the unit req 15 makes coherent: one repository, one exact
 * commit, one validated manifest. Activation is **stage → validate → publish**,
 * and only the last step is visible:
 *
 *   <state>/plugins/<repo-name>/generations/<sha>/                 the checkout
 *   <state>/plugins/<repo-name>/generations/<sha>/.shipit-generation.json
 *   <state>/plugins/<repo-name>/active            symlink → the live generation
 *
 * Publishing is a symlink rename, which is atomic on POSIX: a reader either
 * sees the whole old generation or the whole new one, never a half-staged
 * tree. Any failure before that leaves the previous generation active and
 * whole — "degraded beats partial" (reqs 13, 15).
 *
 * **The record lives INSIDE the generation** (review finding 3). With it
 * beside the directory, `readActiveGeneration` had to resolve the symlink and
 * then read a separate file, and a prune between those two reads reported "no
 * active generation" for a repository that had one. Reading through the
 * symlink makes the pair atomic by construction.
 *
 * **Where it lives is load-bearing.** Generations sit in the session STATE dir
 * (docs/246), a sibling of the clone, so the post-turn `git add -A` can never
 * stage a plugin checkout into the user's repository. Pin records do NOT live
 * there — see `plugin-pins.ts`: a pin is a property of the consuming
 * *project's declaration*, not of one session (req 8).
 *
 * **This module runs no plugin-authored code.** An earlier draft ran the
 * manifest's `install` here, in the orchestrator, with the full process
 * environment — which reads ShipIt's own credentials (the PAT in the global
 * git config) and has unrestricted host access. That is strictly more
 * privileged than `agent.install`, which runs in the session worker, and it is
 * what req 19's fetch-authority boundary exists to prevent. Install therefore
 * lands with the container wiring, where it runs with the same authority
 * `agent.install` already has. Staging a checkout and reading YAML is all that
 * happens here.
 *
 * **Fetching is orchestrator-side** (req 19): the caller injects `ensureCache`,
 * so fetch credentials stay in this process and never reach plugin content.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import simpleGit from "simple-git";
import { parse as parseYaml } from "yaml";
import type { DeclaredPluginRepo, PluginExport } from "../shared/plugin-repos.js";
import { parsePluginExports } from "../shared/plugin-repos.js";
import { resolveDurablePin } from "./plugin-pins.js";

/** Subdirectory of the session state dir that holds every plugin checkout. */
export const PLUGINS_SUBDIR = "plugins";

/** Filename of the generation record, written inside the generation directory. */
const RECORD_FILE = ".shipit-generation.json";

/** A 40-hex object name — a `pin` in this shape needs no ref resolution. */
const SHA_RE = /^[0-9a-f]{40}$/i;

/** The record written inside each generation directory. */
export interface GenerationRecord {
  repoName: string;
  /** The exact commit this generation was built from (req 15). */
  commit: string;
  /** What the consumer declared: `branch main`, `pin v1.2.0`, … */
  ref: string;
  /** ISO timestamp of activation. */
  activatedAt: string;
  /** Exported plugin names found in the manifest (phase-2 selector input). */
  exports: string[];
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
      /** A moved tag that the durable pin overrode (req 8) — advisory, not fatal. */
      warning?: string;
    };

export interface ActivateDeps {
  /** The session's state dir (`sessionStateDir(sessionDir)`). */
  stateDir: string;
  /** Bare cache directory for this plugin repository. */
  bareCacheDir: string;
  /** Clone URL, credentials embedded by the caller if the repo is private. */
  repoUrl: string;
  /**
   * The consuming project's identity — the durable pin is recorded against the
   * *project's declaration*, so every session of one project resolves a pinned
   * tag to the same commit (req 8, review finding 4).
   */
  consumerKey: string;
  /** Path of the orchestrator-wide pin store (outside any session). */
  pinStorePath: string;
  /**
   * Plugin names this consumer selected from the repository (`plugins.use`).
   * A selected name missing from the fetched manifest invalidates the whole
   * generation — plan §1a phase 2, "degraded beats partial".
   */
  selectedExports: readonly string[];
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

/** The symlink every reader follows — the only name that means "live". */
export function activeLinkPath(stateDir: string, repoName: string): string {
  return path.join(repoRoot(stateDir, repoName), "active");
}

/**
 * The active generation's record, or null when nothing is activated.
 *
 * One resolution: the record is read *through* the symlink, so the directory
 * and its record can never disagree, and a concurrent prune cannot open a
 * window where a live repository reports nothing.
 */
export function readActiveGeneration(stateDir: string, repoName: string): GenerationRecord | null {
  try {
    const raw = fs.readFileSync(path.join(activeLinkPath(stateDir, repoName), RECORD_FILE), "utf-8");
    return JSON.parse(raw) as GenerationRecord;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Per-repository serial queue.
 *
 * Not a "join the in-flight promise" map (review finding 5): a `shipit.yaml`
 * edit landing mid-activation would have received the OLD declaration's
 * outcome and queued no follow-up, silently ignoring the edit. Chaining
 * instead means every trigger runs against the declaration it was given, in
 * order, and the last edit always wins.
 */
const queues = new Map<string, Promise<unknown>>();

function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  // eslint-disable-next-line no-restricted-syntax -- Promise two-arg form: run `task` whether the previous entry settled or rejected
  const next = previous.then(task, task);
  queues.set(
    key,
    next.catch(() => undefined).finally(() => {
      if (queues.get(key) === next) queues.delete(key);
    }),
  );
  return next;
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

/**
 * Bring `repo` to its declared version, activating a new generation when the
 * resolved commit differs from the live one.
 *
 * Never throws: every failure resolves to `{status: "failed"}` with the prior
 * generation left active (req 13 — a session opens even when a plugin
 * repository cannot be fetched).
 */
export async function activateGeneration(
  repo: DeclaredPluginRepo,
  deps: ActivateDeps,
): Promise<ActivationOutcome> {
  if (repo.source.kind === "self") {
    // req 27 — the live working tree is the "checkout"; there is nothing to
    // stage, and no commit to be coherent with.
    return { status: "failed", reason: "`repo: self` has no generations — it runs the live working tree" };
  }
  return enqueue(`${deps.stateDir}::${repo.name}`, () => activateOnce(repo, deps));
}

async function activateOnce(repo: DeclaredPluginRepo, deps: ActivateDeps): Promise<ActivationOutcome> {
  const { stateDir, bareCacheDir, repoUrl } = deps;
  const previous = readActiveGeneration(stateDir, repo.name) ?? undefined;
  const withPrevious = previous ? { previous } : {};
  const declaredRef = repo.pin ? `pin ${repo.pin}` : `branch ${repo.branch ?? "(default)"}`;

  try {
    await deps.ensureCache(bareCacheDir, repoUrl);
  } catch (err) {
    return { status: "failed", reason: `could not fetch ${repoUrl}: ${message(err)}`, ...withPrevious };
  }

  let resolved: { commit: string; warning?: string };
  try {
    resolved = await resolveCommit(repo, deps);
  } catch (err) {
    return { status: "failed", reason: message(err), ...withPrevious };
  }
  const { commit } = resolved;
  const warningField = resolved.warning ? { warning: resolved.warning } : {};

  // Already live. Nothing is re-staged and nothing in the live tree is
  // touched: repairing a published generation in place is exactly the
  // partial-state req 15 forbids (review finding 2).
  if (previous?.commit === commit) {
    const missing = missingSelectors(deps.selectedExports, previous.exports);
    if (missing.length > 0) {
      return { status: "failed", reason: selectorError(missing), previous, ...warningField };
    }
    return { status: "unchanged", generation: previous };
  }

  const finalDir = generationDir(stateDir, repo.name, commit);
  const stagingDir = `${finalDir}.staging-${crypto.randomUUID().slice(0, 8)}`;

  try {
    await fsp.mkdir(generationsRoot(stateDir, repo.name), { recursive: true });
    await checkoutCommit(bareCacheDir, stagingDir, commit);

    const exportsList = readManifest(stagingDir);
    // Phase 2 (plan §1a): a selected export that the fetched manifest does not
    // have invalidates the WHOLE repository generation. Checked before publish,
    // so a bad selector never becomes live.
    const missing = missingSelectors(deps.selectedExports, exportsList.map((e) => e.name));
    if (missing.length > 0) {
      await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      return { status: "failed", reason: selectorError(missing), ...withPrevious, ...warningField };
    }

    const record: GenerationRecord = {
      repoName: repo.name,
      commit,
      ref: declaredRef,
      activatedAt: new Date().toISOString(),
      exports: exportsList.map((e) => e.name),
    };
    // The record is written into the staging tree, so the directory that
    // becomes live is complete before it has a name anything reads.
    await fsp.writeFile(path.join(stagingDir, RECORD_FILE), JSON.stringify(record, null, 2));

    await fsp.rm(finalDir, { recursive: true, force: true });
    await fsp.rename(stagingDir, finalDir);
    await swapActiveLink(stateDir, repo.name, commit);
    await pruneOldGenerations(stateDir, repo.name, commit);

    console.log(`[plugins] ${repo.name}: activated ${commit.slice(0, 9)} (${declaredRef})`);
    return { status: "activated", generation: record };
  } catch (err) {
    await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    return { status: "failed", reason: message(err), ...withPrevious, ...warningField };
  }
}

function missingSelectors(selected: readonly string[], available: readonly string[]): string[] {
  const have = new Set(available.map((n) => n.toLowerCase()));
  return selected.filter((n) => !have.has(n.toLowerCase()));
}

function selectorError(missing: readonly string[]): string {
  const names = missing.map((n) => `\`${n}\``).join(", ");
  return `${names} ${missing.length === 1 ? "is" : "are"} not exported by this repository at the declared version.`;
}

/**
 * Resolve the declared version to an exact commit.
 *
 * A `pin` is durable (req 8): the first resolution is recorded against the
 * consuming project's declaration and reused forever after, so a **moved tag
 * does not move the plugin**. A recorded pin is honored WITHOUT re-resolving
 * (review finding 4), so a tag that was later deleted or made ambiguous still
 * activates the exact commit the project pinned.
 */
async function resolveCommit(
  repo: DeclaredPluginRepo,
  deps: ActivateDeps,
): Promise<{ commit: string; warning?: string }> {
  const git = simpleGit(deps.bareCacheDir);

  if (repo.pin) {
    if (SHA_RE.test(repo.pin)) return { commit: repo.pin.toLowerCase() };
    return resolveDurablePin({
      storePath: deps.pinStorePath,
      consumerKey: deps.consumerKey,
      repo,
      resolve: async () => (await git.raw(["rev-parse", `${repo.pin}^{commit}`])).trim(),
    });
  }

  const branch = repo.branch ?? (await defaultBranch(deps.bareCacheDir));
  return { commit: (await git.raw(["rev-parse", `${branch}^{commit}`])).trim() };
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
 * way; it simply exports nothing, and a consumer that selected something from
 * it fails the selector check above.
 */
function readManifest(checkoutDir: string): PluginExport[] {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(checkoutDir, "shipit.yaml"), "utf-8");
  } catch {
    return [];
  }
  const warnings: string[] = [];
  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch {
    return [];
  }
  const exportsBlock = doc && typeof doc === "object" && !Array.isArray(doc)
    ? (doc as Record<string, unknown>).exports
    : undefined;
  const parsed = parsePluginExports(exportsBlock, warnings);
  for (const w of warnings) console.warn(`[plugins] ${checkoutDir}: ${w}`);
  return parsed;
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

/**
 * Drop superseded generations. Re-reads the live link first and skips anything
 * it points at, so a prune can never delete the generation another activation
 * just published (review finding 3). Staging directories belong to whoever is
 * staging them, and a crashed stage's leftovers are swept by the same rule the
 * next time that commit is staged (the `rm` before the rename).
 */
async function pruneOldGenerations(stateDir: string, repoName: string, keepCommit: string): Promise<void> {
  const root = generationsRoot(stateDir, repoName);
  let live = keepCommit;
  try {
    live = path.basename(await fsp.readlink(activeLinkPath(stateDir, repoName)));
  } catch {
    // No link yet — keep the commit we just published.
  }
  let entries: string[];
  try {
    entries = await fsp.readdir(root);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((name) => name !== keepCommit && name !== live && !name.includes(".staging-"))
      .map((name) => fsp.rm(path.join(root, name), { recursive: true, force: true }).catch(() => undefined)),
  );
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
