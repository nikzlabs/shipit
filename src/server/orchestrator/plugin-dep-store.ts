/**
 * docs/262 req 28 — a plugin's declared dependency directories come out of
 * ShipIt's existing shared dependency store instead of being installed cold on
 * every tracked-branch commit.
 *
 * **This adds no store.** docs/183 already keeps one immutable base tree per
 * `(repo, runtime fingerprint, dep-dir)` under `<stateDir>/overlay-base/<scope
 * hash>/g<N>`, with a pointer per scope, a publish CAS, and a disk-janitor
 * sweep. What is new here is a **keying dimension**, and nothing else: a plugin
 * repository's bases are the same trees, in the same subtree, written by the
 * same `publishBase`, reaped by the same sweep — under a scope whose identity is
 * the plugin repository rather than a session's own repo.
 *
 * ## The key, and why it is what req 15 requires
 *
 *   repoUrl    `plugin:<destinationKey(repo.source)>` — the repository the
 *              generation was built from, never the declaration NAME. A name is
 *              re-pointable (`repos: {tools: acme/new}`), so a base keyed by it
 *              would hand a new repository the previous one's installed tree —
 *              exactly the identity hole `GenerationRecord.source` closes for
 *              checkouts.
 *   runtimeKey `overlayRuntimeKey()` + the **content key of the install's
 *              inputs**. The first half is ABI (pinned base-image digest +
 *              arch), inherited from docs/183. The second makes the scope
 *              content-addressed: a base exists for exactly one dep state, so a
 *              pointer existing for a scope IS the proof that its tree is the
 *              right one — no ancestry, no staleness, no cross-commit
 *              invalidation question.
 *   depDir     the declared directory itself, as in docs/183.
 *
 * ## The credential boundary (req 19), by construction
 *
 * The install container never sees the store. On a **hit** it does not run at
 * all; on a **miss** it runs exactly as it did before this existed — one overlay
 * volume whose lowerdir is the staging checkout and whose upperdir is that
 * generation's private writable layer. So the only thing plugin-authored code
 * ever writes is its own per-generation upper layer, and the only thing that
 * ever touches the shared base is the promotion step below, which runs in the
 * orchestrator and moves a directory. Nothing new is mounted into any container
 * that runs plugin code, and nothing crosses the boundary that did not already.
 *
 * Consumers mount a base as an overlay **lowerdir**, which the kernel makes
 * read-only: a plugin service writing into `node_modules` copies up into its own
 * upper layer and the shared tree is untouched.
 *
 * ## Promotion is a rename, and it is only ever sound because the install was cold
 *
 * A generation's upper layer, over a lowerdir that holds no dep dir, IS the
 * complete installed tree — there is nothing below it to merge. That is why the
 * install deliberately does NOT mount the base: it keeps `<upper>/<depDir>`
 * promotable by a `rename(2)` into the store, with no merged snapshot to export
 * from a container the orchestrator cannot mount (the merge problem docs/183
 * solves with a worker HTTP export, which a throwaway install container has no
 * equivalent of). The cost is that a dep-state CHANGE pays one cold install —
 * once, for every session and every later commit that shares that dep state.
 */

import crypto from "node:crypto";
import fs, { type Stats } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import type { SessionInfo } from "../shared/types.js";
import type { PluginExport } from "../shared/plugin-repos.js";
import { destinationKey, pluginCloneUrl } from "../shared/plugin-repos.js";
import { resolveShipitConfig } from "../shared/shipit-config.js";
import { computeInstallDepsHash } from "../shared/deps-hash.js";
import { overlayBaseGenDir, overlayScopeHash } from "./overlay-volume.js";
import { repoUrlToHash } from "./git-utils.js";
import {
  OVERLAY_POINTER_SUBDIR,
  publishBase,
  readBasePointerByHash,
  type OverlayScope,
} from "./overlay-base.js";
import { isOverlayEnabled, overlayRuntimeKey } from "./overlay-session.js";
import { shareTreeWithAllSessions, shareWithAllSessions } from "./session-worker-uid.js";
import { sessionStateDirForWorkspace } from "./session-state-dir.js";
import { pluginsRoot, readGenerationRecordAt } from "./plugin-generations.js";

/** One declared dep dir, resolved to the store scope that would hold it. */
export interface PluginDepDirPlan {
  /** Repository-relative directory, e.g. `node_modules`. */
  depDir: string;
  scope: OverlayScope;
  scopeHash: string;
}

/**
 * What became of ONE declared dep dir. Per-directory rather than a list of the
 * pins that worked, because the caller's obligation is to account for every
 * declared directory: one that is neither pinned nor still in the writable layer
 * is install output that has been lost, and that is a failed install rather than
 * a generation without an optimization.
 */
export interface PluginDepPromotion {
  depDir: string;
  /** Where it now lives in the store, or null if it stayed in the upper layer. */
  pin: string | null;
  /**
   * The tree is in NEITHER place — it left the writable layer and did not reach
   * the store. Only a failure after the rename can do this (a pointer write that
   * fails on a full disk), and the caller must treat it as a failed install:
   * publishing that generation gives the plugin no dependencies at all, with
   * nothing saying why.
   */
  lost: boolean;
}

/** What the store can do for one generation's install. */
export interface PluginDepPlan {
  /** Content key of every selected export's install inputs, folded together. */
  depsKey: string;
  /** The install commands the key covers — recorded on the pointer for diagnosis. */
  installCommands: string[];
  dirs: PluginDepDirPlan[];
}

/**
 * A generation's pinned bases, as recorded in its generation record:
 * `<scopeHash>/g<N>`. Deliberately NOT an absolute path — a record outlives a
 * redeploy, and the store root is this orchestrator's business.
 */
export function pluginBasePin(scopeHash: string, generation: number): string {
  return `${scopeHash}/g${generation}`;
}

const PIN_RE = /^([a-f0-9]{16})\/g([1-9][0-9]*)$/;

/** Parse a recorded pin, fail-closed: this string comes off disk. */
export function parsePluginBasePin(pin: unknown): { scopeHash: string; generation: number } | null {
  if (typeof pin !== "string") return null;
  const m = PIN_RE.exec(pin);
  return m ? { scopeHash: m[1], generation: Number(m[2]) } : null;
}

/** Where a recorded pin resolves on disk, or null if it is not a pin at all. */
export function pluginBasePinDir(depStoreDir: string, pin: unknown): string | null {
  const parsed = parsePluginBasePin(pin);
  return parsed ? overlayBaseGenDir(depStoreDir, parsed.scopeHash, parsed.generation) : null;
}

/**
 * The store scope for one dep dir of one plugin repository at one dep state.
 * Exported for tests and for the live-set walker's sibling reasoning.
 */
export function pluginDepScope(source: string, depsKey: string, depDir: string, env = process.env): OverlayScope {
  return {
    repoUrl: `plugin:${source}`,
    runtimeKey: `${overlayRuntimeKey(env)}|deps:${depsKey}`,
    depDir,
  };
}

/**
 * What the store can offer this generation, or `null` for "nothing — install
 * exactly as before".
 *
 * Null covers every case where reuse would be a guess rather than a fact:
 *
 *  - the `OVERLAY_DEP_STORE` kill switch is off;
 *  - nothing selected declares an `install` (there is no dependency tree);
 *  - an install command is not a recognized pure dependency install, so
 *    `computeInstallDepsHash` returns null (docs/198's codegen-safety rule —
 *    such a command can change its output without the hashed inputs moving, and
 *    a wrong hit here would be a wrong tree in every consumer);
 *  - a declared dep dir already exists in the pristine checkout, which means the
 *    declaration names tracked source rather than a build artifact. docs/183
 *    skips those; here the whole plan is dropped rather than the one directory,
 *    because a repository whose declaration is wrong should be installing
 *    normally while its author fixes it, not half in the store.
 */
export function planPluginDepStore(args: {
  /** `destinationKey(repo.source)` — the repository, never the declaration name. */
  source: string;
  /** Only the exports this consumer selected. */
  exports: readonly PluginExport[];
  /** The staging checkout — pristine, before install. */
  checkoutDir: string;
  env?: NodeJS.ProcessEnv;
}): PluginDepPlan | null {
  const env = args.env ?? process.env;
  if (!isOverlayEnabled(env)) return null;

  // **In execution order, never sorted** (review finding). `installCommands`
  // runs the selected exports in manifest order, and a package manager's result
  // depends on that order — `npm ci` then `npm ci --omit=dev` does not leave the
  // tree the reverse leaves. A key that sorted first would call those two
  // orderings the same dep state and hand one of them the other's tree.
  const installers = args.exports
    .filter((e): e is PluginExport & { install: string } => Boolean(e.install?.trim()));
  if (installers.length === 0) return null;

  const parts: string[][] = [];
  for (const e of installers) {
    const command = e.install.trim();
    // A lifecycle script makes the install a build, whatever the command says
    // (review finding). `npm ci` runs the repository's own `postinstall`, so a
    // commit that changes only `scripts/build.js` produces a DIFFERENT tree
    // under an identical key — and a hit would then skip the build entirely and
    // serve the previous commit's output as this commit's. Declining here is
    // not a guess about what the script does: it is the same rule docs/198
    // applies to an unrecognized command, reached from the manifest instead of
    // from the command line. A plugin that wants the store past this either has
    // no lifecycle script or declares `install-inputs`, which REPLACES the input
    // set and is the author saying what their install actually consumes.
    if (e.installInputs.length === 0 && hasInstallLifecycleScript(args.checkoutDir)) return null;
    const hash = computeInstallDepsHash(
      args.checkoutDir,
      [command],
      e.installInputs.length > 0 ? e.installInputs : null,
    );
    // One unhashable install disables the store for the whole generation: the
    // dep dirs are shared, so a partial key would name a tree that only part of
    // the install produced.
    if (hash === null) return null;
    parts.push([e.name, command, hash]);
  }

  const depDirs: string[] = [];
  for (const e of installers) {
    for (const dir of e.depDirs) {
      if (!depDirs.includes(dir)) depDirs.push(dir);
    }
  }
  if (depDirs.length === 0) return null;
  // A dep dir that is already in the checkout is tracked source, not an install
  // artifact. `existsSync` follows symlinks on purpose — a symlinked dep dir is
  // just as much a thing we must not promote.
  if (depDirs.some((dir) => fs.existsSync(path.join(args.checkoutDir, dir)))) return null;

  const depsKey = crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
  return {
    depsKey,
    installCommands: installers.map((e) => e.install.trim()),
    dirs: depDirs.map((depDir) => {
      const scope = pluginDepScope(args.source, depsKey, depDir, env);
      return { depDir, scope, scopeHash: overlayScopeHash(scope.repoUrl, scope.runtimeKey, scope.depDir) };
    }),
  };
}

/**
 * The npm lifecycle scripts an install RUNS, as opposed to the ones a publish or
 * a test runs. Each of these executes repository code that the manifest and the
 * lockfile do not describe, so its output is not a function of the hashed
 * inputs. `prepublish` is here because npm still runs it on a plain install.
 */
const INSTALL_LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall", "prepare", "prepublish"];

/**
 * Whether the checkout's own `package.json` declares one. Unreadable or absent
 * reads as "no" — there is then no npm install to have a lifecycle at all, and
 * the content key is decided by `computeInstallDepsHash` either way.
 */
function hasInstallLifecycleScript(checkoutDir: string): boolean {
  let pkg: unknown;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(checkoutDir, "package.json"), "utf-8"));
  } catch {
    return false;
  }
  if (typeof pkg !== "object" || pkg === null) return false;
  const scripts = (pkg as { scripts?: unknown }).scripts;
  if (typeof scripts !== "object" || scripts === null) return false;
  return INSTALL_LIFECYCLE_SCRIPTS.some((name) => Boolean((scripts as Record<string, unknown>)[name]));
}

/**
 * The bases that already hold this exact dep state, or `null` if any dep dir is
 * missing one.
 *
 * All-or-nothing on purpose: a hit means the install is skipped entirely, and
 * skipping it with only some of the dep dirs available would leave the plugin
 * with a tree nothing will ever complete. A partial answer degrades to a full
 * install, which then promotes every dir.
 *
 * The generation directory is checked for existence, not merely named by the
 * pointer: a pointer whose tree a sweep removed would otherwise become a
 * lowerdir the daemon cannot mount, and that failure surfaces at container
 * start, far from here.
 */
export function adoptPluginDepBases(depStoreDir: string, plan: PluginDepPlan): string[] | null {
  const pins: string[] = [];
  for (const dir of plan.dirs) {
    const pointer = readBasePointerByHash(depStoreDir, dir.scopeHash);
    if (!pointer) return null;
    if (!fs.existsSync(overlayBaseGenDir(depStoreDir, dir.scopeHash, pointer.generation))) return null;
    pins.push(pluginBasePin(dir.scopeHash, pointer.generation));
  }
  return pins;
}

/**
 * Move each declared dep dir out of this generation's writable layer and into
 * the shared store, and report what is now pinned there.
 *
 * A directory either lands in the store (and leaves the upper layer, so the two
 * never hold two copies) or stays exactly where install left it (and pins
 * nothing). Both outcomes are a complete merged view, which is why a per-dir
 * failure is logged and skipped rather than failing the activation: the store is
 * an accelerator, and the generation is correct without it.
 *
 * Never throws.
 */
export async function promotePluginDepDirs(args: {
  depStoreDir: string;
  plan: PluginDepPlan;
  commit: string;
  /** The generation's upper layer — `<work>/<sha>/upper`. */
  upperDir: string;
  repoName: string;
  env?: NodeJS.ProcessEnv;
}): Promise<PluginDepPromotion[]> {
  const env = args.env ?? process.env;
  const results: PluginDepPromotion[] = [];
  for (const dir of args.plan.dirs) {
    const source = path.join(args.upperDir, dir.depDir);
    // "Still where install left it" is the answer for every path that does not
    // reach the store, so it is computed once, from disk, at the end.
    // Reached only after the tree was there, so a missing source now means the
    // promotion moved it and did not finish.
    const kept = (): PluginDepPromotion =>
      ({ depDir: dir.depDir, pin: null, lost: !fs.existsSync(source) });

    let stat: Stats;
    try {
      stat = await fsp.lstat(source);
    } catch {
      // The install produced nothing here. Not a loss: a declared dep dir this
      // install does not populate is an ordinary, complete outcome.
      results.push({ depDir: dir.depDir, pin: null, lost: false });
      continue;
    }
    // A symlink is not a tree to promote, and following one would copy whatever
    // it points at into a tree every future session mounts.
    if (!stat.isDirectory()) {
      results.push({ depDir: dir.depDir, pin: null, lost: false });
      continue;
    }

    try {
      // Claimed BEFORE the base exists, because a base is unreferenced until the
      // generation record naming it is written — and that write happens in
      // `activateGeneration`, after this returns, behind the phase-3 gate and
      // the publish window (review finding). A sweep landing in that gap sees a
      // scope nothing points at and removes it, and the generation then goes
      // live pinning a directory that was deleted seconds earlier.
      claimPluginBaseScope(dir.scopeHash);
      dropStalePointer(args.depStoreDir, dir.scopeHash);
      const result = await publishBase({
        stateDir: args.depStoreDir,
        scope: dir.scope,
        candidate: {
          commit: args.commit,
          exitCode: 0,
          // Both true by construction rather than by inspection: a plugin
          // install is run by ShipIt against a pristine checkout of the declared
          // revision, before any consumer can touch it. There is no user edit to
          // race, and the declared ref IS this scope's source of truth.
          preUserInstall: true,
          sourceIsDefaultBranch: true,
          snapshotDir: source,
          markerStamp: {
            runtimeKey: overlayRuntimeKey(env),
            installCommands: args.plan.installCommands,
            depsHash: args.plan.depsKey,
          },
        },
        // The scope is content-addressed, so an existing base for it already
        // holds this dep state — there is nothing to order and nothing to
        // advance. Declining keeps exactly one generation per scope, which is
        // also what keeps the janitor's "current generation" rule sufficient to
        // protect every base a live generation pins.
        isAncestor: async () => false,
        materialize: (snapshotDir, scopeHash, generation) =>
          moveIntoBase(args.depStoreDir, snapshotDir, scopeHash, generation, dir.depDir),
        // docs/270 — this override used to skip the recursive walk, on the
        // grounds that "the tree was written by the install container as the
        // worker uid already". That premise died with the single worker uid:
        // the install container now runs as ONE session's own uid, and this
        // generation is a SHARED base that other sessions mount as an overlay
        // lowerdir. overlayfs copy-up preserves the lower file's owner AND mode,
        // and the install container writes `0644`/`0755` — so without the walk a
        // second session copies up a file it can read and cannot write, and
        // EACCESes on its first edit. Take the module default (a group share,
        // not a chown): it costs one walk per PUBLISH, not per session.
        chownBaseDir: shareTreeWithAllSessions,
      });

      const pointer = result.pointer;
      const genDir = pointer
        ? overlayBaseGenDir(args.depStoreDir, dir.scopeHash, pointer.generation)
        : null;
      if (!pointer || !genDir || !fs.existsSync(genDir)) {
        results.push(kept());
        continue;
      }
      if (result.outcome !== "created") {
        // Another session promoted this same dep state first. Its tree is ours
        // by definition — same repository, same runtime, same input content — so
        // adopt it and drop our copy rather than keeping two.
        await fsp.rm(source, { recursive: true, force: true });
      }
      results.push({
        depDir: dir.depDir,
        pin: pluginBasePin(dir.scopeHash, pointer.generation),
        lost: false,
      });
    } catch (err) {
      console.warn(
        `[plugins] ${args.repoName}: could not share \`${dir.depDir}\` with other sessions:`,
        err instanceof Error ? err.message : String(err),
      );
      results.push(kept());
    }
  }
  return results;
}

/**
 * Scopes a promotion has created but no generation record names yet.
 *
 * **The window this closes is not small.** A base becomes reachable the moment
 * `publishBase` writes its pointer, but its first *liveness* record is the
 * generation record `activateGeneration` writes afterwards — behind the phase-3
 * gate, the staging rename and the session-wide publish window. The disk
 * janitor's pass fires on every session activation and shares no lock with any
 * of that, so a concurrent activation elsewhere could reclaim a base a
 * generation was about to pin, and the generation would go live pinning a
 * directory that no longer exists (review finding).
 *
 * **Time-bounded rather than released, deliberately.** The natural release point
 * is "the record now names it", which happens in another module after this one
 * has returned; threading a handle through the install result to the generation
 * engine would couple the two for a window measured in seconds. A claim that
 * simply expires is the same shape `post-turn-hold.ts` uses, and it fails in the
 * right direction: an over-long claim costs one undeleted base until the next
 * pass, and process death drops every claim — correct, because a process that
 * died before writing the record never published the generation, so the base
 * genuinely has no pinner.
 */
const IN_FLIGHT_CLAIM_MS = 10 * 60_000;
const inFlightScopes = new Map<string, number>();

function claimPluginBaseScope(scopeHash: string): void {
  inFlightScopes.set(scopeHash, Date.now() + IN_FLIGHT_CLAIM_MS);
}

/**
 * Drop every claim. For tests, which share this module across cases the way the
 * process shares it across sessions — the same reason
 * `clearUntrustedContainerNetworks` exists.
 */
export function clearPluginBaseClaims(): void {
  inFlightScopes.clear();
}

/** Unexpired claims, pruning as it goes so the map cannot grow with the process. */
function liveInFlightScopes(): string[] {
  const now = Date.now();
  for (const [scopeHash, expiry] of inFlightScopes) {
    if (expiry <= now) inFlightScopes.delete(scopeHash);
  }
  return [...inFlightScopes.keys()];
}

/**
 * Forget a pointer whose tree is gone, so the scope can be published again.
 *
 * The pointer and the generations it names live in **different subtrees**
 * (`overlay-base-meta/` beside `overlay-base/`, which is deliberate — a pointer
 * file inside a base would surface in every merged mount), so a sweep, a manual
 * clean or a half-finished reclaim can leave one without the other. Left alone
 * that scope is permanently unusable in BOTH directions: `adoptPluginDepBases`
 * refuses a pointer it cannot resolve, and `publishBase` answers a candidate at
 * the same commit with `skipped-equal` before it consults any oracle — so no
 * later install ever replaces it, and the plugin installs cold forever.
 *
 * Safe without a lock, and only for a plugin scope: no session shares one, and
 * the worst interleaving is that a pointer another install wrote microseconds
 * earlier is dropped — costing one re-publish of a tree that is still on disk,
 * never a wrong tree. Doing nothing costs a permanently cold plugin.
 */
function dropStalePointer(depStoreDir: string, scopeHash: string): void {
  const pointer = readBasePointerByHash(depStoreDir, scopeHash);
  if (!pointer) return;
  if (fs.existsSync(overlayBaseGenDir(depStoreDir, scopeHash, pointer.generation))) return;
  fs.rmSync(path.join(depStoreDir, OVERLAY_POINTER_SUBDIR, `${scopeHash}.json`), { force: true });
}

/**
 * `publishBase`'s materialize hook, as a **rename**: the installed tree is moved
 * from the generation's upper layer into a fresh base generation.
 *
 * Two renames, both free (one filesystem — the store subtree and every session's
 * state dir are subpaths of the same state volume) and both atomic. The staging
 * name is what makes the second one safe: a `g<N>` that appeared before its
 * content did would be visible to the janitor's generation sweep as an empty
 * base, and to a concurrent reader as a mountable one. `.tmp-*` is the name the
 * sweep already gives an hour's grace.
 *
 * The base tree is rooted at the dep dir's own relative path (`g<N>/<depDir>/…`)
 * because it is mounted as a lowerdir of the plugin ROOT, stacked under the
 * checkout — not at the dep dir itself. One volume per generation stays one
 * volume, and no container surface has to learn about a second mount.
 *
 * A cross-device rename (a deployment whose sessions and store live on different
 * filesystems) falls back to a copy. A failure after the tree has already left
 * the upper layer puts it back — that layer is the only other copy.
 */
async function moveIntoBase(
  depStoreDir: string,
  snapshotDir: string,
  scopeHash: string,
  generation: number,
  depDir: string,
): Promise<string> {
  const genDir = overlayBaseGenDir(depStoreDir, scopeHash, generation);
  const scopeDir = path.dirname(genDir);
  await fsp.mkdir(scopeDir, { recursive: true });
  const tmp = path.join(scopeDir, `.tmp-g${generation}-${crypto.randomBytes(4).toString("hex")}`);
  const target = path.join(tmp, depDir);
  await fsp.mkdir(path.dirname(target), { recursive: true });

  let moved = false;
  try {
    try {
      await fsp.rename(snapshotDir, target);
      moved = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
      await fsp.cp(snapshotDir, target, { recursive: true, verbatimSymlinks: true });
      await fsp.rm(snapshotDir, { recursive: true, force: true });
      moved = true;
    }
    await fsp.rm(genDir, { recursive: true, force: true });
    await fsp.rename(tmp, genDir);
  } catch (err) {
    if (moved) await fsp.rename(target, snapshotDir).catch(() => undefined);
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  // docs/270 — the dep store is SHARED between sessions, so these container
  // dirs are group-shared rather than chowned to one uid. Non-recursive by
  // design: the generation's CONTENTS get the recursive share from
  // `chownBaseDir` at publish. The setgid bit is what lets a later session
  // publish a sibling generation into the same scope.
  shareWithAllSessions(scopeDir);
  shareWithAllSessions(genDir);
  return genDir;
}

/**
 * Where a plugin repository's downloaded packages are cached — the docs/075
 * per-repo download cache, under its own identity.
 *
 * The `plugin:` prefix keeps it in a different hash space from any project
 * repository's cache even when a project and a plugin are literally the same
 * repository (req 27's self case is not this path, but a project consuming a
 * plugin repo it also builds is): one repository's cached content never appears
 * under another's name (req 15).
 */
export function pluginDepCacheDir(depStoreDir: string, source: string): string {
  return path.join(depStoreDir, "dep-cache", repoUrlToHash(`plugin:${source}`));
}

/**
 * What the disk janitor must not reclaim: every dependency-store artifact some
 * session's plugin generation still depends on.
 *
 * Both sweeps need it, for different reasons and with different stakes:
 *
 *  - **Base scopes.** Without this the overlay-base sweep reads a plugin base as
 *    an orphan (no session's `agent.dep-dirs` scope hash matches it) and removes
 *    it, out from under generations that mount it as a lowerdir. A running
 *    container's mount protects it only while the container runs; an idle
 *    session's plugin would come back to a lowerdir that no longer exists. This
 *    one is correctness.
 *  - **Download caches, and the bare git caches beside them.**
 *    `sweepOrphanedCaches` removes every `repo-cache/<hash>` and
 *    `dep-cache/<hash>` it cannot match to a repository in the **repo store** —
 *    with no age guard. A declared plugin repository is never in that store
 *    (nothing adds one; verified at `services/plugin-activation.ts`, which only
 *    ever calls `deps.getBareCacheDir(cloneUrl(repo))`), so BOTH of a plugin's
 *    caches were deleted on the first pass after they were written — and that
 *    pass fires on every session activation. The bare cache is the older and
 *    larger of the two: "a bare cache per plugin repository, shared across
 *    sessions and generations" was true of the code that creates it and untrue
 *    of the deployment, which re-cloned the repository on every activation
 *    round. These are speed, not correctness, but they are exactly the speed
 *    req 28 asks for.
 *
 * **Deliberately NOT gated on the `OVERLAY_DEP_STORE` kill switch.** The switch
 * decides whether NEW generations use the store; generations that already pin a
 * base still need it, and flipping the switch off must not delete their
 * dependencies. Existing pins are a fact on disk, not a feature flag.
 *
 * Every generation is walked, not just the live one: a superseded generation can
 * still be mounted by a companion CLI or a plugin service under the same lease
 * that keeps it on disk (req 15).
 */
export async function livePluginStoreArtifacts(
  sessions: readonly SessionInfo[],
): Promise<{ scopeHashes: Set<string>; cacheHashes: Set<string> }> {
  // In-flight promotions first, so a base created moments ago is live before
  // anything walks a session tree that cannot yet mention it.
  const scopeHashes = new Set<string>(liveInFlightScopes());
  const cacheHashes = new Set<string>();
  for (const session of sessions) {
    if (!session.workspaceDir) continue;
    if (session.diskTier === "evicted") continue;

    // The declared repositories' caches, BOTH of them, read from the
    // declaration. The bare cache must come from here because its hash is over
    // the clone URL byte-for-byte and only the declaration still has its case
    // (`destinationKey` has lowercased it). The download cache must come from
    // here because the install CREATES it before any generation exists to name
    // it (review finding): derived from a published record alone, a first
    // activation's `/dep-cache` could be deleted by a concurrent sweep while the
    // install was writing into it, and a failed activation would leave it
    // unprotected until one finally published.
    try {
      for (const repo of resolveShipitConfig(session.workspaceDir).plugins.repos) {
        if (repo.source.kind === "self") continue;
        cacheHashes.add(repoUrlToHash(pluginCloneUrl(repo.source)));
        cacheHashes.add(path.basename(pluginDepCacheDir("", destinationKey(repo.source))));
      }
    } catch {
      // Unreadable config — the generation records below still protect this
      // session's bases, and the next pass (after the next successful read)
      // protects its caches again.
    }

    let root: string;
    try {
      root = pluginsRoot(sessionStateDirForWorkspace(session.workspaceDir));
    } catch {
      continue;
    }
    for (const repoName of await listDirs(root)) {
      const generations = path.join(root, repoName, "generations");
      for (const generationId of await listDirs(generations)) {
        const record = readGenerationRecordAt(path.join(generations, generationId));
        if (!record) continue;
        for (const pin of record.basePins ?? []) {
          const parsed = parsePluginBasePin(pin);
          if (parsed) scopeHashes.add(parsed.scopeHash);
        }
        // The cache is keyed by the repository this generation came from, so a
        // generation with no recorded source keeps nothing alive — the same
        // fail-closed rule every other reader of that field follows.
        if (typeof record.source === "string" && record.source) {
          cacheHashes.add(path.basename(pluginDepCacheDir("", record.source)));
        }
      }
    }
  }
  return { scopeHashes, cacheHashes };
}

/**
 * Directory names, distinguishing "there is nothing here" from "I could not
 * look" (review finding). Swallowing both made an unreadable generation tree
 * indistinguishable from a session with no plugins — and the caller's answer
 * feeds a destructive sweep, so a transient EIO or EACCES would have read as
 * "nothing pins these bases". Anything but absence propagates, and
 * {@link livePluginStoreArtifacts}'s caller skips the sweeps for that pass.
 */
async function listDirs(dir: string): Promise<string[]> {
  try {
    return (await fsp.readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw err;
  }
}
