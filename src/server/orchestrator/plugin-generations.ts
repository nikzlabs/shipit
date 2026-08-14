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
import { parsePluginExports, destinationKey } from "../shared/plugin-repos.js";
import { resolveDurablePin } from "./plugin-pins.js";

/** Subdirectory of the session state dir that holds every plugin checkout. */
export const PLUGINS_SUBDIR = "plugins";

/**
 * Per-repo subdirectory holding one writable layer per generation
 * (`work/<sha>/upper` + `work/<sha>/work`). Named here rather than in
 * `plugin-overlay.ts` because pruning lives on this side: a layer must be
 * dropped with the generation it belongs to.
 */
export const WORK_SUBDIR = "work";

/** Filename of the generation record, written inside the generation directory. */
const RECORD_FILE = ".shipit-generation.json";

/** A 40-hex object name — a `pin` in this shape needs no ref resolution. */
const SHA_RE = /^[0-9a-f]{40}$/i;

/** The record written inside each generation directory. */
export interface GenerationRecord {
  repoName: string;
  /**
   * What the declaration pointed at when this generation was built —
   * `owner/repo` lowercased (`destinationKey`). The NAME is not identity: a
   * consumer can re-point `tools` from `acme/old` to `acme/new`, and every
   * on-disk path is keyed by the name, so without this field the old
   * repository's generation stays live under the new declaration and every
   * reader — the Plugins tab, the feedback footer, `SHIPIT_PLUGIN_COMMIT` —
   * reports the new repository at the old repository's commit.
   */
  source: string;
  /** The exact commit this generation was built from (req 15). */
  commit: string;
  /** What the consumer declared: `branch main`, `pin v1.2.0`, … */
  ref: string;
  /** ISO timestamp of activation. */
  activatedAt: string;
  /** Exported plugin names found in the manifest (phase-2 selector input). */
  exports: string[];
  /**
   * Warnings from parsing the fetched repository's manifest (an unknown key, a
   * dropped export). Recorded rather than only logged, so the Plugins tab can
   * show them — a degradation the user cannot see is not req 13's "degrade,
   * visibly" (review finding).
   */
  manifestWarnings: string[];
}

/** What `activateGeneration` did. */
export type ActivationOutcome =
  | { status: "unchanged"; generation: GenerationRecord; warning?: string }
  | { status: "activated"; generation: GenerationRecord; warning?: string }
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
      /**
       * The selected exports the declared version does not have, when THIS is
       * why the attempt failed (phase 2). `reason` already names them; the
       * names travel separately so the snapshot can tell that its own
       * per-selector message would only repeat the failure (verified live in
       * the dogfood instance: the card stated one fact twice).
       */
      missingSelectors?: string[];
    };

/**
 * One repository's install work for a generation that is staged but not yet
 * published. `stagingDir` is a directory nothing else can see yet, so an
 * install that fails or is abandoned leaves no trace.
 */
export interface PluginInstallJob {
  repoName: string;
  commit: string;
  /** The staged checkout — NOT a published generation. */
  stagingDir: string;
  /** Only the exports this consumer selected; unselected ones are not installed. */
  exports: readonly PluginExport[];
  /**
   * Whether the session this install belongs to is gone. Passed INTO the job
   * rather than only checked around it: an install is the one step here that
   * runs for minutes, so a session archived while it runs must be able to stop
   * it — otherwise third-party code keeps running, and its container keeps
   * holding the generation's volume, long after the session it served.
   */
  isCancelled?: () => boolean;
}

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
  /**
   * Whether the session this activation belongs to is gone (archived, reset,
   * disposed). Checked before each step that creates durable state, which
   * NARROWS the window in which a slow activation re-creates a session's state
   * directory after cleanup removed it — it does not close it (review finding;
   * see the check before staging for the exact gap).
   */
  isCancelled?: () => boolean;
  /**
   * Run the selected plugins' `install` against the STAGING checkout, before
   * anything is published. Injected, because this module deliberately runs no
   * plugin-authored code in its own process — the implementation puts that
   * code in its own container, where ShipIt's credentials and the worker's
   * loopback credential broker are both out of reach (req 19).
   *
   * Omitted (tests, and any caller with nothing to install) → the step is
   * skipped and activation behaves exactly as before.
   */
  runInstall?: (job: PluginInstallJob) => Promise<{ ok: boolean; reason?: string }>;
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
 * One generation's record, read from a CONCRETE generation directory.
 *
 * The directory-scoped form exists because a caller that needs several facts
 * about the live generation — its record, its manifest, its directory as an
 * overlay lowerdir — must resolve `active` **once** and read all of them out of
 * that one answer. Following the symlink per fact lets a refresh landing
 * between two of them return a commit from generation B and a checkout from C,
 * and the CLI invocation container then gets a volume named for B whose
 * lowerdir is C's tree (sibling report, docs/262). Whoever resolves the link is
 * responsible for holding onto the result.
 */
export function readGenerationRecordAt(generationDir: string): GenerationRecord | null {
  try {
    const raw = fs.readFileSync(path.join(generationDir, RECORD_FILE), "utf-8");
    return JSON.parse(raw) as GenerationRecord;
  } catch {
    return null;
  }
}

/**
 * That same generation's own manifest, from a CONCRETE directory. Non-logging,
 * like {@link readActiveManifest}: this runs per request and activation already
 * logged any warning once.
 */
export function readGenerationManifestAt(generationDir: string): PluginExport[] {
  return readManifest(generationDir, false).exports;
}

/**
 * The active generation's record, or null when nothing is activated — or when
 * what is activated came from a DIFFERENT repository than `expectedSource`.
 *
 * One resolution: the record is read *through* the symlink, so the directory
 * and its record can never disagree, and a concurrent prune cannot open a
 * window where a live repository reports nothing. Callers needing MORE than
 * the record should resolve the link themselves and use the `…At` readers
 * above — see their docstring for why.
 *
 * `expectedSource` is required rather than optional on purpose: every caller
 * has the declaration in hand, and an optional check is one every caller can
 * forget. A record written before the field existed has no `source`, so it
 * reads as a mismatch and the next activation re-stages it — cheaper than
 * trusting a generation whose origin nothing recorded.
 */
export function readActiveGeneration(
  stateDir: string,
  repoName: string,
  expectedSource: string,
): GenerationRecord | null {
  const record = readGenerationRecordAt(activeLinkPath(stateDir, repoName));
  return record?.source === expectedSource ? record : null;
}

/**
 * The active generation's own manifest — the `exports.plugins` block of the
 * commit that is actually running.
 *
 * `readActiveGeneration` records export NAMES only, which answers "is this
 * selector real?" and nothing else. Readers that need what an export
 * *declares* — its credential names (req 23), later its settings and hosts —
 * read the manifest itself, through the same `active` symlink so the answer
 * always belongs to the live commit. Null when nothing is activated; an
 * unparseable manifest reads as an empty export list, exactly as activation
 * treats it.
 *
 * It takes `expectedSource` for the same reason {@link readActiveGeneration}
 * does, and it is the same symlink: a re-pointed declaration would otherwise
 * validate this consumer's selectors, settings and declared credentials against
 * the PREVIOUS repository's manifest. The record is what carries the source, so
 * the check runs there and the manifest is only read once it passes.
 */
export function readActiveManifest(
  stateDir: string,
  repoName: string,
  expectedSource: string,
): PluginExport[] | null {
  const verified = resolveVerifiedGeneration(stateDir, repoName, expectedSource);
  return verified ? readGenerationManifestAt(verified.dir) : null;
}

/**
 * Resolve `active` ONCE and hand back the concrete directory together with the
 * record that proves it belongs to `expectedSource` — or null.
 *
 * Two facts about the same generation want two reads, and reading each through
 * the symlink is how they come from different generations. Checking the record
 * through the link and then reading the manifest through the link again is
 * exactly that hazard, in the one function whose whole job is to answer for a
 * single commit: a re-point plus a publish landing between the two reads
 * validates this consumer's selectors, settings and credential names against a
 * manifest whose record was never checked. So the link is resolved once here
 * and every fact is read out of that one answer.
 *
 * Not exported yet on purpose. The resolve-once sweep (docs/262) needs exactly
 * this shape at the snapshot route, where several readers answer for one repo
 * on one request — it should export this rather than add a second resolver
 * beside it.
 */
function resolveVerifiedGeneration(
  stateDir: string,
  repoName: string,
  expectedSource: string,
): { dir: string; record: GenerationRecord } | null {
  let dir: string;
  try {
    dir = fs.realpathSync(activeLinkPath(stateDir, repoName));
  } catch {
    return null; // nothing activated, or the link no longer resolves
  }
  const record = readGenerationRecordAt(dir);
  return record?.source === expectedSource ? { dir, record } : null;
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

/** Live queue entries — exported so a test can prove they are released. */
export function activationQueueSize(): number {
  return queues.size;
}

function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  // eslint-disable-next-line no-restricted-syntax -- Promise two-arg form: run `task` whether the previous entry settled or rejected
  const next = previous.then(task, task);
  // The map holds `tail`, so the cleanup guard must compare against `tail` —
  // comparing against `next` (the unwrapped promise) can never match, and the
  // entry would live for the process lifetime (review finding).
  const tail: Promise<unknown> = next.catch(() => undefined).finally(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  queues.set(key, tail);
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
  const source = destinationKey(repo.source);
  // A declaration re-pointed at a different repository keeps every on-disk path
  // (they are keyed by NAME), so the previous repository's generation would
  // otherwise stay live under the new declaration. Reading it as absent is not
  // enough — the `active` symlink still resolves, so the container keeps linking
  // `/plugins/<name>` at the old repository's files. Retire it here, BEFORE the
  // fetch that can fail: req 15's "keep the prior generation live" means the
  // prior generation of THIS plugin, and a stranger's files are not a
  // degradation of it. The declaration then reads as unavailable until the new
  // source activates, which is the honest state.
  await retireForeignGeneration(stateDir, repo.name, source);
  const previous = readActiveGeneration(stateDir, repo.name, source) ?? undefined;
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
  // partial-state req 15 forbids (review finding).
  if (previous?.commit === commit) {
    const missing = missingSelectors(deps.selectedExports, previous.exports);
    if (missing.length > 0) {
      return { status: "failed", reason: selectorError(missing), missingSelectors: missing, previous, ...warningField };
    }
    return { status: "unchanged", generation: previous, ...warningField };
  }

  // Cancelled before anything durable exists: a session archived mid-fetch
  // must not have its state directory re-created by the staging `mkdir`.
  //
  // **This narrows the window; it does not close it** (review finding — an
  // earlier comment here claimed the stronger thing). Disposal can land between
  // this check and the `mkdir` below, and then the recursive `mkdir` recreates
  // the parent directories cleanup had just removed; the cancellation cleanup
  // further down removes the staging tree but not those parents. The same
  // shape exists between the last check and the publish. What the epoch DOES
  // guarantee is that no in-memory state is resurrected for a disposed
  // session; a filesystem barrier would need the disposal path itself to
  // participate, which it does not today.
  if (deps.isCancelled?.()) {
    return { status: "failed", reason: "the session went away before activation completed", ...withPrevious };
  }

  const finalDir = generationDir(stateDir, repo.name, commit);
  const stagingDir = `${finalDir}.staging-${crypto.randomUUID().slice(0, 8)}`;

  try {
    await fsp.mkdir(generationsRoot(stateDir, repo.name), { recursive: true });
    await checkoutCommit(bareCacheDir, stagingDir, commit);

    const { exports: exportsList, warnings: manifestWarnings } = readManifest(stagingDir);
    // Phase 2 (plan §1a): a selected export that the fetched manifest does not
    // have invalidates the WHOLE repository generation. Checked before publish,
    // so a bad selector never becomes live.
    const missing = missingSelectors(deps.selectedExports, exportsList.map((e) => e.name));
    if (missing.length > 0) {
      await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      return {
        status: "failed",
        reason: selectorError(missing),
        missingSelectors: missing,
        ...withPrevious,
        ...warningField,
      };
    }

    // Install runs HERE — against the staging tree, before anything is
    // published (plan §1b). An earlier revision published first and installed
    // afterwards, fire-and-forget: a failed install then left the new commit
    // live with the prior generation already pruned, so the session had a
    // plugin that was reported `active` and did not work. In this order a
    // failed install is simply a failed activation, and req 15's "the prior
    // version remains active" holds for it like any other failure.
    //
    // Note what is NOT here: the install itself. This module runs no
    // plugin-authored code in-process — `runInstall` is injected, and its
    // implementation puts that code in its own container (req 19).
    const selected = exportsList.filter((e) =>
      deps.selectedExports.some((n) => n.toLowerCase() === e.name.toLowerCase()),
    );
    if (deps.runInstall) {
      // Checked HERE, not only at the two publish gates: fetch, checkout and
      // manifest validation all take time, so a session disposed during them
      // would otherwise have reached this line and started minutes of
      // third-party code — which `prepareLayer` precedes by re-creating the
      // very state directory cleanup had just removed.
      if (deps.isCancelled?.()) {
        await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
        return { status: "failed", reason: "the session went away before activation completed", ...withPrevious };
      }
      const outcome = await deps.runInstall({
        stagingDir,
        commit,
        repoName: repo.name,
        exports: selected,
        ...(deps.isCancelled ? { isCancelled: deps.isCancelled } : {}),
      });
      if (!outcome.ok) {
        await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
        return {
          status: "failed",
          reason: outcome.reason ?? "plugin install failed",
          ...withPrevious,
          ...warningField,
        };
      }
    }

    // No install runner at all (local/dogfood mode, tests) but a selected
    // export declares one: the generation is genuinely partial, so say so
    // rather than reporting it plainly `active`. Publishing anyway is
    // deliberate — this is the runtime the inner dogfood instance uses, and a
    // repository that cannot activate there cannot be exercised there either.
    // Req 13's rule is "degrade visibly", not "refuse".
    const uninstalled = deps.runInstall
      ? []
      : selected.filter((e) => e.install?.trim()).map((e) => e.name);
    const notInstalled = uninstalled.length > 0
      ? `${uninstalled.map((n) => `\`${n}\``).join(", ")} declare an install command, which this runtime cannot run — the plugin is active but was not installed.`
      : undefined;

    const record: GenerationRecord = {
      repoName: repo.name,
      source,
      commit,
      ref: declaredRef,
      activatedAt: new Date().toISOString(),
      exports: exportsList.map((e) => e.name),
      manifestWarnings: notInstalled ? [...manifestWarnings, notInstalled] : manifestWarnings,
    };
    // The record is written into the staging tree, so the directory that
    // becomes live is complete before it has a name anything reads.
    await fsp.writeFile(path.join(stagingDir, RECORD_FILE), JSON.stringify(record, null, 2));

    // Last check before publishing: everything up to here is confined to a
    // staging directory that the cleanup below removes.
    if (deps.isCancelled?.()) {
      await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      return { status: "failed", reason: "the session went away before activation completed", ...withPrevious };
    }

    await fsp.rm(finalDir, { recursive: true, force: true });
    await fsp.rename(stagingDir, finalDir);
    await swapActiveLink(stateDir, repo.name, commit);
    await pruneOldGenerations(stateDir, repo.name, commit);

    console.log(`[plugins] ${repo.name}: activated ${commit.slice(0, 9)} (${declaredRef})`);
    // The uninstalled warning outranks a moved-tag advisory: one says the
    // plugin does not fully work, the other that a pin held.
    if (notInstalled) return { status: "activated", generation: record, warning: notInstalled };
    return { status: "activated", generation: record, ...warningField };
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
function readManifest(
  checkoutDir: string,
  /** Read-only readers pass false: this runs per request, and re-logging the
   * same manifest warning on every poll says nothing activation did not
   * already log once. */
  log = true,
): { exports: PluginExport[]; warnings: string[] } {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(checkoutDir, "shipit.yaml"), "utf-8");
  } catch {
    return { exports: [], warnings: [] };
  }
  const warnings: string[] = [];
  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (err) {
    return { exports: [], warnings: [`This repository's shipit.yaml could not be parsed: ${message(err)}`] };
  }
  const exportsBlock = doc && typeof doc === "object" && !Array.isArray(doc)
    ? (doc as Record<string, unknown>).exports
    : undefined;
  const exportsList = parsePluginExports(exportsBlock, warnings);
  if (log) for (const w of warnings) console.warn(`[plugins] ${checkoutDir}: ${w}`);
  return { exports: exportsList, warnings };
}

/**
 * Drop everything a PREVIOUS repository left under this declaration's name.
 *
 * Only runs when the live record names a different source (or names none —
 * a record written before the field existed). Removing the `active` symlink is
 * the load-bearing half: while it resolves, the container's prepare pass keeps
 * linking `/plugins/<name>` at the old repository's checkout, whatever any
 * reader believes. The generations and their writable layers go with it, since
 * nothing can ever name them again.
 */
async function retireForeignGeneration(
  stateDir: string,
  repoName: string,
  expectedSource: string,
): Promise<void> {
  let record: GenerationRecord;
  try {
    const raw = await fsp.readFile(path.join(activeLinkPath(stateDir, repoName), RECORD_FILE), "utf-8");
    record = JSON.parse(raw) as GenerationRecord;
  } catch {
    return; // nothing live (or unreadable) — the normal activation path handles it
  }
  if (record.source === expectedSource) return;
  // **Unknown provenance is not proof of foreignness.** A record written before
  // `source` existed carries none, so this code cannot tell whose generation it
  // is — and "cannot tell" is not "someone else's". Retiring it
  // would be destructive twice over: the first activation round after this ships
  // would drop EVERY plugin in EVERY live session at once, and because the
  // retirement runs before the fetch (and `previous` is read after it), a fetch
  // that then fails — a private plugin repository the host's App is not
  // installed on, exactly what req 6/10 exists to report — returns `failed` with
  // no previous generation at all. The plugin goes dark rather than degrading,
  // which is the opposite of req 15. A legacy generation is instead replaced by
  // the next successful publish, exactly as an ordinary refresh replaces it.
  //
  // **The residual, stated rather than left implied** (review finding): keeping
  // the tree is not the same as serving it. Every reader here refuses a record
  // whose source it cannot match, so the card says "no active version" — but the
  // CONTAINER side follows this symlink with no record at all, so `/plugins/
  // <name>`, the materialized skills and the wrapper names keep describing that
  // tree until a successful publish replaces it. The container's own guard is
  // its own change (docs/262 checklist); the choice here is only "do not delete
  // what we cannot prove is a stranger's".
  if (record.source === undefined) return;

  await fsp.rm(activeLinkPath(stateDir, repoName), { force: true });
  await Promise.all([
    fsp.rm(generationsRoot(stateDir, repoName), { recursive: true, force: true }),
    fsp.rm(path.join(repoRoot(stateDir, repoName), WORK_SUBDIR), { recursive: true, force: true }),
  ]);
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
 * Drop superseded generations, their writable layers, and abandoned staging
 * trees. Re-reads the live link first and skips anything it points at, so a
 * prune can never delete the generation another activation just published
 * (review finding 3).
 *
 * **Staging directories are pruned here too.** An earlier version excluded
 * them, reasoning that a crashed stage's leftovers are swept "the next time
 * that commit is staged". They are not: each stage picks a fresh random
 * suffix, and the `rm` before the rename targets the FINAL directory, so an
 * abandoned `.staging-<uuid>` tree is never named again by anything. Pruning
 * them here is safe because activation is serialized per (session, repository):
 * no other stage for this repo can be in flight while this one publishes.
 *
 * **And the writable layers.** `work/<sha>` outlives its generation otherwise —
 * install output for every superseded commit, kept forever, which is the
 * opposite of what a per-generation layer is for.
 */
async function pruneOldGenerations(stateDir: string, repoName: string, keepCommit: string): Promise<void> {
  const root = generationsRoot(stateDir, repoName);
  let live = keepCommit;
  try {
    live = path.basename(await fsp.readlink(activeLinkPath(stateDir, repoName)));
  } catch {
    // No link yet — keep the commit we just published.
  }
  const keep = new Set([keepCommit, live]);

  let entries: string[];
  try {
    entries = await fsp.readdir(root);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((name) => !keep.has(name))
      .map((name) => fsp.rm(path.join(root, name), { recursive: true, force: true }).catch(() => undefined)),
  );

  // The writable layers, keyed by the same commit names.
  const workRoot = path.join(repoRoot(stateDir, repoName), WORK_SUBDIR);
  let layers: string[];
  try {
    layers = await fsp.readdir(workRoot);
  } catch {
    return; // no layers yet — nothing installed for this repo
  }
  await Promise.all(
    layers
      .filter((name) => !keep.has(name))
      .map((name) => fsp.rm(path.join(workRoot, name), { recursive: true, force: true }).catch(() => undefined)),
  );
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
