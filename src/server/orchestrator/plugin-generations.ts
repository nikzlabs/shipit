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
 * **Validation is what the caller injects, not what this module knows.** The
 * phase-2 selector check below is answerable from the manifest alone, so it
 * lives here. Phase 3 — "would this version's services actually come up?" — is
 * answerable only from the consuming session's compose world, and this module
 * deliberately depends on very little. So it takes a `validateStaged` hook and
 * calls it against the STAGING tree, before publish (plan §1a phase 3). A
 * rejected candidate is an ordinary failed activation: the prior generation
 * stays whole and live, which is the whole point — see {@link ValidateStagedGeneration}.
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
import { safeSimpleGit } from "../shared/git-hooks-guard.js";
import { parse as parseYaml } from "yaml";
import type { DeclaredPluginRepo, PluginExport } from "../shared/plugin-repos.js";
import { parsePluginExports, destinationKey, declaredRefLabel } from "../shared/plugin-repos.js";
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
  /**
   * req 28 — shared dependency bases this generation's install left in the
   * store, as `<scopeHash>/g<N>` (`plugin-dep-store.ts`). Every container that
   * mounts this generation stacks them under the checkout; the disk janitor
   * reads them to know the base is still in use.
   *
   * Absent when nothing was shared — a plugin with no install, an install the
   * content key cannot cover, the kill switch, or a runtime with no installer at
   * all. An absent list means "this generation is self-contained", which is what
   * every generation was before this existed.
   */
  basePins?: string[];
}

/**
 * Ask permission to delete one superseded generation, and keep that permission
 * until the returned function is called. `null` → leave it exactly where it is.
 *
 * Implemented by `plugin-leases.ts`; declared here because this module is the
 * only caller and the shape belongs to the prune, not to the lease.
 */
export type BeginGenerationDeletion = (
  generation: { repoName: string; commit: string },
) => Promise<(() => void) | null>;

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
  /**
   * What the declaration points at — `owner/repo` lowercased
   * (`destinationKey`). The install shares its result under this identity
   * (req 28), never under the declaration NAME: a name is re-pointable, and a
   * shared tree keyed by one would hand a new repository the previous
   * repository's installed dependencies (req 15).
   */
  source: string;
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

/** What an install run reports back. */
export interface PluginInstallResult {
  ok: boolean;
  reason?: string;
  /**
   * req 28 — the shared dependency bases this install ended up pinning
   * (`plugin-dep-store.ts`), recorded on the generation so every later mount and
   * the disk janitor read the same answer. Absent when nothing was shared, which
   * is a complete generation exactly as it was before the store existed.
   */
  basePins?: string[];
}

/**
 * A generation that is staged but not yet published, offered to the phase-3
 * gate. Same shape as {@link PluginInstallJob}'s first three fields and for the
 * same reason: `stagingDir` is a directory nothing else can see yet, so a
 * candidate that is rejected leaves no trace.
 */
export interface StagedGeneration {
  repoName: string;
  /**
   * What the declaration pointed at when this was staged — `owner/repo`
   * lowercased (`destinationKey`).
   *
   * Carried because the gate re-reads the CURRENT declaration and the name is
   * not identity: a `shipit.yaml` edit landing mid-round can re-point `tools`
   * at another repository, and a gate that matched on name alone would judge
   * this candidate against the new repository's world and then let it publish
   * under the new declaration.
   */
  source: string;
  commit: string;
  /** The staged checkout — NOT a published generation. */
  stagingDir: string;
}

/**
 * Phase 3 of the naming/validation phases (plan §1a), as a **pre-publish gate**.
 *
 * It answers one question about a candidate: *if this became the live
 * generation, would this repository's declared surfaces work?* A `false` is an
 * ordinary failed activation — nothing is published, the staging tree is
 * removed, and the prior complete version keeps running (req 15, "degraded
 * beats partial").
 *
 * **Why it is a hook and not a call.** The answer needs the consuming session's
 * compose world — the project's own service names, the other imports' live
 * generations, this session's egress posture — none of which this module knows
 * or should learn. `services/plugin-preflight.ts` implements it; omitted (tests,
 * and any caller with no compose world) the step is skipped and activation
 * behaves exactly as it did before.
 *
 * **It is called inside the publish window, not beside the phase-2 check.** The
 * question is about the moment the symlink swaps, and the answer depends on
 * what ELSE is live in the session — so a verdict reached before `install` is a
 * verdict about a world that had minutes to change. Repositories activate in
 * parallel and the generation queue is per repository, so two first-time
 * candidates exporting one service name would each see the other as not-live,
 * both pass, and both publish. Checking under the session's publish lock, one
 * step before the swap, is what makes the check and the publication one
 * decision. The cost — a doomed candidate has already run its `install` — is
 * wasted work in a throwaway container, which is the cheaper half of the trade.
 *
 * **What it deliberately does NOT gate: companion-CLI command names** (domain 5
 * of the same phase). §1a's amendment settles that unit — a contested command
 * withholds *that command* from every claimant and activates everything else,
 * because a command collision is a defect in the consuming declaration rather
 * than in either repository's version, and both are fixed in the same `use`
 * entry (`overrides.commands.<x>.as`). Failing the whole generation over it
 * would take out a working plugin's services and skills over a naming clash it
 * did not cause. The refusal is already reported on the repository's card
 * (`plugin-commands.ts`, recomputed per snapshot), so it is visible without
 * being fatal. Stated here rather than left as an omission, so the next slice
 * does not build a second mechanism for it.
 */
export type ValidateStagedGeneration = (
  staged: StagedGeneration,
) => { ok: true } | { ok: false; reason: string };

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
   * Take the consumer lease over a superseded generation, so its checkout and
   * writable layer are deleted only when nothing is running against them
   * (req 15 — `plugin-leases.ts`). Call the returned function when the deletion
   * is done; `null` means a live consumer still has it and nothing must be
   * removed.
   *
   * Injected for the same reason `runInstall` is: half the answer belongs to
   * Docker (a volume a container still holds cannot be removed, which is the
   * only evidence that survives an orchestrator restart), and this module holds
   * no Docker client. Omitted where there is none — local/dogfood mode and
   * tests — and there nothing can be holding a generation, because there are no
   * plugin containers at all.
   */
  beginGenerationDeletion?: BeginGenerationDeletion;
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
  runInstall?: (job: PluginInstallJob) => Promise<PluginInstallResult>;
  /**
   * The phase-3 pre-publish gate ({@link ValidateStagedGeneration}). Injected
   * for the same reason `runInstall` is: the answer lives outside this module.
   */
  validateStaged?: ValidateStagedGeneration;
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

/** A generation directory together with the record proving whose it is. */
export interface VerifiedGeneration {
  dir: string;
  record: GenerationRecord;
}

/**
 * One operation's answer to "which generation is live for this declared repo",
 * resolved once per repository and reused by every reader in that operation.
 * `null` for a `repo: self` declaration (no generation by design, req 27) and
 * for a repository with nothing live — or nothing live that belongs to it.
 */
export type LiveGenerations = (repo: DeclaredPluginRepo) => VerifiedGeneration | null;

/**
 * Resolve every declared repository's live generation ONCE, for one operation.
 *
 * **Which readers belong here, and which must not** (docs/262, the rule the
 * cohort converged on): this is for reads whose results are **compared or
 * combined as if they came from one generation** — the snapshot route's card,
 * where a commit, a manifest, a fragment and a settings verdict all describe
 * one repository, and the service build, where a definition and the tree it
 * mounts must match. Three shapes are excluded by construction, and each one
 * BREAKS if it is folded in:
 *
 *  - a read whose subject IS the change — `plugin-refresh.ts`'s before/after
 *    pair, and `plugin-activation.ts`'s pre-activation read. Collapse those and
 *    every refresh reports `unchanged` and the card names the new generation as
 *    the one it is replacing.
 *  - a stored path that must FOLLOW a later swap — `/plugins/<name>` links the
 *    unresolved `active` on purpose, so a new generation reaches the agent with
 *    no re-link.
 *  - an operation that already resolves once — the feedback issue's footer
 *    (`api-routes-issues.ts`), whose residual window is between its read and the
 *    GitHub POST and is what "what this session was running" means.
 *
 * Resolved on FIRST ASK and memoized, not eagerly for every declared repo. The
 * guarantee the readers need is per-repository — the facts one card or one
 * mount states about ONE repository come from one generation — and memoizing
 * gives exactly that. Resolving the whole list up front would additionally pin
 * every repository at a single instant, which nothing compares across
 * repositories, at the cost of resolving repositories the operation never
 * reads: `plugin-cli-run.ts` builds this for the collision verdict over the
 * OTHER imports while its target is pinned separately by `pinGeneration` (that
 * pin also names the volume and the lowerdir), so an eager pass followed the
 * target's `active` a second time for an answer it then discarded (review
 * finding). A repository nobody asks about is never touched.
 */
export function resolveLiveGenerations(
  stateDir: string,
  repos: readonly DeclaredPluginRepo[],
): LiveGenerations {
  const declared = new Map(repos.map((r) => [r.name.toLowerCase(), r]));
  const resolved = new Map<string, VerifiedGeneration | null>();
  return (repo) => {
    const key = repo.name.toLowerCase();
    // Resolve the DECLARATION under that name, never the argument: a caller
    // holding a stale repo object gets this operation's answer for the
    // repository the project currently declares, or nothing.
    const declaration = declared.get(key);
    if (!declaration) return null;
    if (!resolved.has(key)) {
      resolved.set(
        key,
        // req 27 — a self declaration IS the working tree; it has no generation
        // to resolve and no commit to be verified against.
        declaration.source.kind === "self"
          ? null
          : resolveVerifiedGeneration(stateDir, declaration.name, destinationKey(declaration.source)),
      );
    }
    return resolved.get(key) ?? null;
  };
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
 *
 * **These readers carry no identity check, and cannot.** A directory proves
 * nothing about which repository produced it; the record does, so the check
 * lives where the link is resolved — {@link resolveVerifiedGeneration} and
 * {@link resolveLiveGenerations}. They are therefore safe on a directory one of
 * those returned, and on nothing else: reaching for them with a directory you
 * resolved yourself is how a re-pointed declaration goes back to serving the
 * previous repository's files, and it looks like a pure refactor while doing it.
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
 * Exported for {@link resolveLiveGenerations}, which is how an operation with
 * several readers gets ONE answer per repository. A caller that needs a single
 * fact should still use `readActiveGeneration` / `readActiveManifest`: they are
 * this function with the reading attached, and they cannot be given a directory
 * nobody verified.
 */
export function resolveVerifiedGeneration(
  stateDir: string,
  repoName: string,
  expectedSource: string,
): VerifiedGeneration | null {
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
 * Serial queues, on two keys with two jobs.
 *
 * **Per repository** (`<stateDir>::<repoName>`) — one activation at a time for
 * one declared repository. Not a "join the in-flight promise" map (review
 * finding 5): a `shipit.yaml` edit landing mid-activation would have received
 * the OLD declaration's outcome and queued no follow-up, silently ignoring the
 * edit. Chaining instead means every trigger runs against the declaration it
 * was given, in order, and the last edit always wins.
 *
 * **Per session** ({@link publishKey}) — the publish WINDOW: phase-3
 * validation, the rename, and the link swap. Repositories activate in parallel
 * (`plugin-activation.ts` maps them through `Promise.all`), and the per-repo key
 * says nothing across repositories — but phase 3 is a question about the whole
 * session's name domain, so its answer is only worth anything if nothing else
 * can publish between asking and swapping. This key is what makes those one
 * decision. It deliberately does NOT cover fetch, checkout or `install`, which
 * are per-repository work and stay concurrent (req 14).
 */
const queues = new Map<string, Promise<unknown>>();

/**
 * The session-wide publish key. `/` cannot appear in a declared repo name
 * (`PLUGIN_NAME_RE` allows letters, digits, `.`, `_` and `-`), so this can never
 * collide with a per-repository key.
 */
function publishKey(stateDir: string): string {
  return `${stateDir}::/publish`;
}

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
  await retireForeignGeneration(stateDir, repo.name, source, deps.beginGenerationDeletion);
  const previous = readActiveGeneration(stateDir, repo.name, source) ?? undefined;
  const withPrevious = previous ? { previous } : {};
  const declaredRef = declaredRefLabel(repo);

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

    // **Everything from here to the rename touches THIS commit's durable
    // artifacts, so it runs under the consumer lease** (req 15 —
    // `plugin-leases.ts`). Two of them, and both are reachable by the same
    // route: a project that pins back to a version it recently ran, whose
    // generation a prune left in place precisely because a companion CLI or a
    // plugin service was still using it.
    //
    //  - `work/<commit>` — install CLEARS the upper and work dirs before it
    //    writes (`plugin-install.ts`'s `prepareLayer`, which must: a
    //    half-populated upper from an earlier failure would otherwise be merged
    //    in as if it had succeeded). That is the live upper layer of the volume
    //    the consumer is running on.
    //  - `generations/<commit>` — cleared before the staging tree is renamed
    //    into place, which replaces the consumer's overlay lowerdir with a fresh
    //    inode. docs/183's spike records the result: merged `readdir` starts
    //    coming back empty while path lookups still resolve, so the container
    //    misbehaves rather than fails.
    //
    // Refusing instead is an ordinary failed activation — the prior version
    // stays live (req 15) and the next round succeeds once the consumer is done.
    // Nothing can take a NEW hold on this commit while the claim is held,
    // because `active` does not name it: a commit that was already live returned
    // `unchanged` far above and never reaches this line.
    const clearGeneration = deps.beginGenerationDeletion
      ? await deps.beginGenerationDeletion({ repoName: repo.name, commit }).catch(() => null)
      : noop;
    if (!clearGeneration) {
      await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      return {
        status: "failed",
        reason: `the copy of ${commit.slice(0, 9)} already in this session is still in use — try again in a moment`,
        ...withPrevious,
        ...warningField,
      };
    }

    // The lease is released once, from whichever path reaches it first — the
    // publish window releases it deliberately before the link swap, and the
    // `finally` below catches every path that never got there.
    let leaseReleased = false;
    const releaseLease = (): void => {
      if (leaseReleased) return;
      leaseReleased = true;
      clearGeneration();
    };

    let record: GenerationRecord;
    let notInstalled: string | undefined;
    // req 28 — what the install left in the shared dependency store. Recorded on
    // the generation because every consumer of this checkout must stack the same
    // bases under it, and because a base with no recorded pinner is one the disk
    // janitor is entitled to reclaim.
    let basePins: string[] = [];
    try {
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
          source,
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
        basePins = outcome.basePins ?? [];
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
      // Agrees with itself in the ONE-plugin case, which is the common one and
      // the only one the dogfood ever showed: the card read "`probe` declare an
      // install command … the plugin is active". A card is the whole report a
      // user gets about a partial version (req 13), so it reads as written.
      const one = uninstalled.length === 1;
      notInstalled = uninstalled.length > 0
        ? `${uninstalled.map((n) => `\`${n}\``).join(", ")} ${one ? "declares" : "declare"} an install command, `
          + `which this runtime cannot run — ${one ? "the plugin is" : "the plugins are"} active but `
          + `${one ? "was" : "were"} not installed.`
        : undefined;

      record = {
        repoName: repo.name,
        source,
        commit,
        ref: declaredRef,
        activatedAt: new Date().toISOString(),
        exports: exportsList.map((e) => e.name),
        manifestWarnings: notInstalled ? [...manifestWarnings, notInstalled] : manifestWarnings,
        ...(basePins.length > 0 ? { basePins } : {}),
      };
      // The record is written into the staging tree, so the directory that
      // becomes live is complete before it has a name anything reads.
      await fsp.writeFile(path.join(stagingDir, RECORD_FILE), JSON.stringify(record, null, 2));

      // **The publish window** — phase 3, the rename and the link swap, as ONE
      // decision serialized across the session (see {@link enqueue}'s publish
      // key). Phase 3's answer depends on what else is live in this session, and
      // repositories activate in parallel behind per-repository queues, so a
      // verdict reached anywhere earlier is a verdict about a world that can
      // change before the swap: two first-time candidates exporting one service
      // name would each see the other as not-live and both publish. Inside this
      // lock, the second one sees the first.
      const refusal = await enqueue(publishKey(stateDir), async () => {
        if (deps.validateStaged) {
          const verdict = deps.validateStaged({ repoName: repo.name, source, commit, stagingDir });
          if (!verdict.ok) return verdict.reason;
        }
        // Last check before publishing: everything up to here is confined to a
        // staging directory that the cleanup below removes.
        if (deps.isCancelled?.()) return "the session went away before activation completed";

        await fsp.rm(finalDir, { recursive: true, force: true });
        await fsp.rename(stagingDir, finalDir);
        // Released BEFORE the link swap, so the moment `active` names this
        // commit a consumer can hold it. The other order leaves a window in
        // which the live generation refuses every hold. The outer `finally`
        // still covers every path that never reaches this line.
        releaseLease();
        await swapActiveLink(stateDir, repo.name, commit);
        return null;
      });
      if (refusal !== null) {
        await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
        return { status: "failed", reason: refusal, ...withPrevious, ...warningField };
      }
    } finally {
      releaseLease();
    }
    await pruneOldGenerations(stateDir, repo.name, commit, deps.beginGenerationDeletion);

    console.log(`[plugins] ${repo.name}: activated ${commit.slice(0, 9)} (${declaredRef})`);
    // `notInstalled` is deliberately NOT returned as the attempt `warning` as
    // well: it is already in the record's `manifestWarnings` above, and
    // `buildRepoView` unshifts BOTH channels into one `issues` list — so
    // returning it here rendered the same sentence twice on the card (seen in
    // the dogfood, where no install runner exists so every activation carries
    // it). The record is the right home of the two, because it is durable: the
    // condition holds for as long as that generation is live in this runtime,
    // and the card must state it on a session that reopens without activating
    // anything, where there is no attempt to carry a warning at all.
    //
    // Returning `warningField` unconditionally also stops it being swallowed.
    // The old branch returned `notInstalled` INSTEAD of it, so a moved-tag
    // advisory vanished whenever the runtime could not install — the two are
    // about different things and are not each other's alternative.
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
  const git = safeSimpleGit(deps.bareCacheDir);

  if (repo.pin) {
    if (SHA_RE.test(repo.pin)) return { commit: repo.pin.toLowerCase() };
    return resolveDurablePin({
      storePath: deps.pinStorePath,
      consumerKey: deps.consumerKey,
      repo,
      resolve: () => revParse(git, repo, repo.pin!),
    });
  }

  const branch = repo.branch ?? (await defaultBranch(deps.bareCacheDir));
  return { commit: await revParse(git, repo, branch) };
}

/**
 * `git rev-parse <rev>^{commit}`, with the ONE failure a consuming project
 * actually causes named rather than relayed (req 13 — say why).
 *
 * A typo'd, deleted or never-pushed ref is the commonest way an activation
 * fails, and git's own answer to it is three lines of argument-syntax advice
 * ("Use '--' to separate paths from revisions") headed by the echoed argument.
 * The dogfood put that verbatim on the Plugins card and in the `shipit plugin
 * refresh` row, where it reads as a ShipIt malfunction rather than as "that
 * branch is not there". Anything else git says is kept whole underneath the
 * name: an unreadable cache or a broken object store is exactly the case this
 * must not swallow.
 */
async function revParse(
  git: ReturnType<typeof safeSimpleGit>,
  repo: DeclaredPluginRepo,
  rev: string,
): Promise<string> {
  try {
    return (await git.raw(["rev-parse", `${rev}^{commit}`])).trim();
  } catch (err) {
    const where = destinationKey(repo.source);
    const detail = message(err);
    // Only the recognized shape gets the DIAGNOSIS. Everything else gets a
    // neutral prefix and keeps git's own text whole: an unreadable cache or a
    // directory that is not a repository would otherwise be reported as a
    // missing branch, which sends the reader to fix a declaration that is
    // correct (review finding).
    return Promise.reject(new Error(
      /unknown revision|ambiguous argument|Needed a single revision/i.test(detail)
        ? `\`${rev}\` is not a branch, tag or commit in \`${where}\`.`
        : `could not resolve \`${rev}\` in \`${where}\`: ${detail}`,
    ));
  }
}

async function defaultBranch(bareCacheDir: string): Promise<string> {
  const head = (await safeSimpleGit(bareCacheDir).raw(["symbolic-ref", "--short", "HEAD"])).trim();
  return head || "main";
}

/** Materialize `commit` into `targetDir` from the bare cache (hardlinked objects). */
async function checkoutCommit(bareCacheDir: string, targetDir: string, commit: string): Promise<void> {
  await safeSimpleGit().raw(["clone", "--local", "--no-checkout", bareCacheDir, targetDir]);
  const git = safeSimpleGit(targetDir);
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
 *
 * `unknownIsForeign` is the `repo: self` case — see
 * {@link retireSelfDeclaredGeneration}, its only caller.
 */
async function retireForeignGeneration(
  stateDir: string,
  repoName: string,
  expectedSource: string,
  begin: BeginGenerationDeletion | undefined,
  unknownIsForeign = false,
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
  //
  // **`repo: self` is the one caller that CAN prove it** (review finding). The
  // conservatism above rests on "a legacy record might be this declaration's" —
  // and under a self declaration it cannot be, because nothing ever publishes a
  // generation for one (`activateGeneration` refuses it a hundred lines up). So
  // there is no version to keep whole, no fetch that could fail and leave the
  // plugin dark, and every reader already refuses the tree: keeping it only
  // leaves a previous repository's files readable through the store mount for
  // the session's life. The flag is passed by exactly that caller, so the
  // tracked path's answer is unchanged.
  if (record.source === undefined && !unknownIsForeign) return;

  await fsp.rm(activeLinkPath(stateDir, repoName), { force: true });
  // The trees go through the same lease the prune uses: a re-point is still an
  // update, and a companion CLI or plugin service running against the previous
  // repository's generation must not have its checkout deleted mid-run either
  // (req 15). Removing the link above is what makes the retirement effective —
  // it is what the container's prepare pass follows — so a tree that outlives
  // its consumer by one round is addressable by nothing and is reclaimed by the
  // next publish's prune.
  await dropGenerations(stateDir, repoName, new Set(), begin);
}

/**
 * Retire whatever is published under a name the project declares `repo: self`
 * (req 27) — the one reconciliation no activation will ever do for itself.
 *
 * A self declaration stages nothing, so `activateGeneration` never runs for it
 * and the retirement `activateOnce` performs before its fetch never happens.
 * Left alone, a name re-pointed from `owner/repo` to `self` keeps the previous
 * repository's checkout published for the session's whole life — refused by
 * every reader, and still readable through the read-only store mount.
 *
 * **Two things this adds over calling the retirement directly**, both found by
 * review, and both about the fact that rounds overlap while a new round does not
 * cancel the one before it.
 *
 * It runs **on the per-repository queue**, the same key `activateGeneration`
 * serializes on. Off the queue, a round that read the declaration while it said
 * `self` could delete a generation that a LATER round had meanwhile published
 * for a tracked declaration of the same name — or remove its staging tree, which
 * the publish path is entitled to assume nothing else touches.
 *
 * And it **re-asks `stillSelf` inside the queued task**, because ordering alone
 * is not enough: serialized after that publish, a stale round would still delete
 * a perfectly good tracked generation. The declaration on disk at the moment the
 * work runs is the only version of it worth acting on — the same rule
 * `syncPluginState` follows for settings, and for the same reason.
 */
export async function retireSelfDeclaredGeneration(
  stateDir: string,
  repoName: string,
  begin: BeginGenerationDeletion | undefined,
  stillSelf: () => boolean,
): Promise<void> {
  await enqueue(`${stateDir}::${repoName}`, async () => {
    if (!stillSelf()) return;
    // Unknown provenance IS foreign here — see the comment inside.
    await retireForeignGeneration(stateDir, repoName, SELF_SOURCE, begin, true);
  });
}

/** What `destinationKey` renders for a `repo: self` declaration. */
const SELF_SOURCE = destinationKey({ kind: "self" });

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
async function pruneOldGenerations(
  stateDir: string,
  repoName: string,
  keepCommit: string,
  begin: BeginGenerationDeletion | undefined,
): Promise<void> {
  let live = keepCommit;
  try {
    live = path.basename(await fsp.readlink(activeLinkPath(stateDir, repoName)));
  } catch {
    // No link yet — keep the commit we just published.
  }
  await dropGenerations(stateDir, repoName, new Set([keepCommit, live]), begin);
}

/**
 * Remove every generation of `repoName` except `keep`, checkout and writable
 * layer together, under the consumer lease (req 15 — `plugin-leases.ts`).
 *
 * **A generation and its layer are one unit.** They were pruned by two separate
 * passes before, which is exactly the shape that lets one of them be leased and
 * the other deleted; the lease is taken once and covers both.
 *
 * **Abandoned staging trees are outside the lease, and correctly so.** They are
 * named `<sha>.staging-<uuid>`, so they fail the object-name test below and are
 * removed unconditionally: publish RENAMES a staging tree, it never mounts one,
 * so no consumer can ever have had it. Only a published generation has an
 * identity a consumer could be holding.
 *
 * Never throws. A prune runs immediately after a publish that already succeeded,
 * so a daemon hiccup here must not turn an activated generation into a reported
 * failure.
 */
async function dropGenerations(
  stateDir: string,
  repoName: string,
  keep: ReadonlySet<string>,
  begin: BeginGenerationDeletion | undefined,
): Promise<void> {
  const root = generationsRoot(stateDir, repoName);
  const workRoot = path.join(repoRoot(stateDir, repoName), WORK_SUBDIR);
  const [entries, layers] = await Promise.all([listNames(root), listNames(workRoot)]);

  // Leftovers from a stage that never published — no identity, no consumer.
  await Promise.all(
    entries
      .filter((name) => !keep.has(name) && !SHA_RE.test(name))
      .map((name) => fsp.rm(path.join(root, name), { recursive: true, force: true }).catch(() => undefined)),
  );

  const superseded = new Set(
    [...entries, ...layers].filter((name) => SHA_RE.test(name) && !keep.has(name)),
  );
  await Promise.all(
    [...superseded].map(async (commit) => {
      const done = begin ? await begin({ repoName, commit }).catch(() => null) : noop;
      if (!done) {
        // req 15 — the prior complete version keeps running. A consumer still
        // has this tree mounted, so it stays; the next publish's prune retries,
        // and a session that never refreshes again takes the whole state
        // directory with it when it goes.
        console.log(
          `[plugins] ${repoName}: ${commit.slice(0, 9)} is still in use — leaving it for a later round`,
        );
        return;
      }
      try {
        await fsp.rm(path.join(root, commit), { recursive: true, force: true }).catch(() => undefined);
        await fsp.rm(path.join(workRoot, commit), { recursive: true, force: true }).catch(() => undefined);
      } finally {
        done();
      }
    }),
  );
}

function noop(): void {
  /* no lease to release */
}

async function listNames(dir: string): Promise<string[]> {
  try {
    return await fsp.readdir(dir);
  } catch {
    return [];
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
