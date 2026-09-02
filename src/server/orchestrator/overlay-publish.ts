/**
 * Overlay dep store — publish-after-install orchestration (docs/183 Phase 4b).
 *
 * The seam that turns a finished install into the next shared rolling base, **per
 * declared dep dir**. It composes the three lower layers built earlier:
 *
 *   - `overlay-session.ts` — eligibility + the per-dep-dir scope (`resolveOverlayScope`,
 *     `depDirsForSession`, `validDepDirsForOverlay`).
 *   - `overlay-snapshot.ts` — the worker pull + tar extraction (`fetchDepSnapshotStream`,
 *     `extractTarStream`, `fetchWorkspaceHeadInfo`).
 *   - `overlay-base.ts` — the publish compare-and-swap (`publishBase`), reused
 *     **unchanged**: only the caller and the per-dep-dir granularity are new here.
 *
 * Wiring lives at the install-completion seam (`service-manager-setup.ts`): after a
 * session's `agent.install` resolves, the runner-adapting hook constructed in
 * `index.ts` calls `publishDepDirOverlayBases` once. The overlay store is ON by
 * default; the module is inert when the `OVERLAY_DEP_STORE=0`/`false` kill switch
 * is set OR the session is overlay-ineligible — either returns `[]` before any
 * I/O, so non-overlay sessions are byte-for-byte unchanged.
 *
 * Best-effort by construction: a publish never affects the install or the session.
 * The caller swallows a thrown hook; within a dep-dir loop a per-dir failure is
 * recorded as an `"error"` outcome and the other dirs still publish. That guarantee
 * is only as strong as the pull's error surface — see `overlay-snapshot.ts` for why
 * a mid-stream socket death must reject rather than emit (it crashed prod on
 * 2026-07-30). `args.signal` closes the other half: the runner's disposal aborts the
 * in-flight pull, so archiving a session cancels its publish instead of racing the
 * container's SIGKILL.
 *
 * ## Eligibility (plan §3)
 *
 * A candidate publishes only when its install **exited 0**, was a **pre-user**
 * install, and its **source base is the remote default-branch commit**. We resolve:
 *   - `exitCode` from the install result (`installOk`),
 *   - `commit` from the worker’s merged HEAD (`fetchWorkspaceHeadInfo`),
 *   - `currentDefaultCommit` from the bare cache (`RepoGit.resolveDefaultBranchCommit`),
 *   - `sourceIsDefaultBranch = commit === currentDefaultCommit`.
 *
 * `preUserInstall` is `true` here: this hook fires at the setup/activation install
 * seam, before any agent turn has run for the runner, and the `sourceIsDefaultBranch`
 * gate further restricts publishing to an untouched default-branch checkout. The one
 * residual gap (uncommitted dep edits while HEAD still equals the default tip) is
 * acceptable given that gate.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";

import type { SessionInfo } from "../shared/types.js";
import { resolveShipitConfig } from "../shared/shipit-config.js";
import { computeInstallDepsHash } from "../shared/deps-hash.js";
import {
  isOverlayEnabled,
  isPnpmRepo,
  resolveOverlayScope,
  depDirsForSession,
  validDepDirsForOverlay,
} from "./overlay-session.js";
import { publishBase, type PublishOutcome } from "./overlay-base.js";
import {
  extractTarStream,
  fetchDepSnapshotStream,
  fetchWorkspaceHeadInfo,
  type WorkspaceHeadInfo,
} from "./overlay-snapshot.js";
import type { RepoGit } from "./repo-git.js";

/** Just the bare-cache ancestry oracle the publish CAS needs (a `RepoGit` slice). */
export type AncestryOracle = Pick<RepoGit, "isAncestor" | "resolveDefaultBranchCommit">;

export interface OverlayPublishDeps {
  /**
   * Orchestrator-visible state dir whose `overlay-base/<scope-hash>/` subtree holds
   * the rolling bases — the SAME directory the disk-janitor sweeps and the daemon
   * mounts as `lowerdir` (the scope hash is path-independent, so the orchestrator's
   * view and the daemon-host mountpoint resolve to the same volume contents).
   */
  stateDir: string;
  /** Bare-cache git oracle factory (ancestry + default-branch commit). */
  createRepoGit: (repoDir: string) => AncestryOracle;
  /** Resolve a repo's bare-cache dir from its remote URL. */
  getBareCacheDir: (repoUrl: string) => string;
  env?: NodeJS.ProcessEnv;
  /** HTTP/tar glue — injectable so the orchestration is unit-testable without a worker. */
  fetchSnapshot?: (workerUrl: string, depDir: string, signal?: AbortSignal) => Promise<Readable>;
  fetchHeadInfo?: (workerUrl: string, signal?: AbortSignal) => Promise<WorkspaceHeadInfo | null>;
  extract?: (stream: Readable, destDir: string) => Promise<void>;
  /** Root for per-dep-dir extraction temp dirs (defaults to the OS temp dir). */
  tmpRoot?: string;
}

export interface OverlayPublishArgs {
  session: Pick<SessionInfo, "remoteUrl" | "kind" | "workspaceDir">;
  /** Base HTTP URL of the session worker (`runner.getWorkerUrl()`). */
  workerUrl: string;
  /** Whether the just-finished `agent.install` exited 0. */
  installOk: boolean;
  /**
   * The exact `agent.install` command list the install ran. Recorded (with the
   * worker's runtime key) on the resulting base pointer so a later same-commit
   * session can be pre-stamped with a marker the /install gate accepts (see
   * `preStampInstallMarker`). Optional — without it the publish proceeds and
   * only the pre-stamp optimization is forgone.
   */
  installCommands?: string[];
  /**
   * Cancels the pull the moment the session's runner is disposed/archived. The
   * snapshot producer is the session container; archiving SIGKILLs it mid-stream,
   * so without this the orchestrator keeps reading from a socket that is about to
   * be torn down (a ~295 MB read on the prod crash of 2026-07-30). Aborting turns
   * that race into a prompt, ordinary rejection instead.
   */
  signal?: AbortSignal;
}

/**
 * Per-dep-dir result — the publish CAS outcome, `"error"` if the dir's
 * pull/extract/publish threw, or `"skipped-empty"` if the exported snapshot
 * contained nothing (an empty dep dir is never a useful base — and an empty
 * snapshot is the signature of a session whose merged view is broken or whose
 * install was wrongly skipped; publishing it would poison the scope for every
 * future session, observed live in docs/183 measurement).
 */
export interface DepDirPublishOutcome {
  depDir: string;
  outcome: PublishOutcome | "error" | "skipped-empty";
  error?: string;
  /**
   * docs/183 — overlay depth of this dep dir's base after the publish (from the
   * resulting pointer): 1 right after a `created`/`flattened`/`reset`, climbing on
   * each `advanced`. The key signal for depth-cap tuning. Absent for skips/errors
   * that didn't read a pointer.
   */
  depth?: number;
  /** Base generation after the publish (bumps on advance/flatten/reset). */
  generation?: number;
  /**
   * How many pull+extract attempts this dep dir needed (see
   * {@link SNAPSHOT_ATTEMPTS}). `1` is the ordinary case; `2` says the retry fired,
   * i.e. the first read raced a concurrent write into the dep dir — the production
   * degradation the retry exists for. Without this, a retry that keeps succeeding
   * looks exactly like a run that never raced, so the churn is unmeasurable from
   * the logs. Absent when no pull was attempted (aborted before it started, or an
   * install that declined every dir before any I/O).
   */
  attempts?: number;
}

/**
 * How many times a single dep dir's pull+extract may be attempted. Two, not more:
 * the failure this exists for is a ONE-SHOT write into the dep dir during the read
 * (see below), which a second attempt no longer sees. A dep dir being written
 * continuously is not a safe base at any attempt count, and each attempt is a
 * full multi-hundred-MB transfer.
 */
const SNAPSHOT_ATTEMPTS = 2;

/**
 * Pull a dep dir's snapshot and extract it, retrying once on failure.
 *
 * The dep dir is NOT quiescent while the worker tars it: compose services start in
 * parallel with `agent.install`, and a running Node dev server writes inside the dep
 * dir it is served from — creating `node_modules/.vite` moves the dep dir's own
 * mtime, so tar exits 1 and the worker refuses to call the archive a base. Measured
 * on the production host 2026-09-02 that lost the rolling base in 18 of 46 live
 * containers (~39%).
 *
 * A retry is the right answer rather than tolerating the raced archive, because
 * tar's exit-1 evidence is about the archive it just wrote and says nothing about
 * the next one: the cache directory a dev server creates once is already there on
 * the second read, so attempt 2 is clean and we publish something tar itself called
 * exact. Tolerating instead would publish an archive that may be missing a top-level
 * entry created after tar read the dep dir's listing — under a base pointer whose
 * install marker later lets a session skip installing altogether.
 *
 * An abort (the session was disposed mid-pull — a NORMAL event here, see the module
 * docstring) is never retried: the worker is gone, so a second attempt would only
 * stream from a socket that is already being torn down.
 */
async function pullSnapshotWithRetry(args: {
  workerUrl: string;
  depDir: string;
  destDir: string;
  fetchSnapshot: (workerUrl: string, depDir: string, signal?: AbortSignal) => Promise<Readable>;
  extract: (stream: Readable, destDir: string) => Promise<void>;
  signal?: AbortSignal;
  /**
   * Written on every attempt, so the count survives the THROW as well as the
   * return. A plain return value would report the retry only when it succeeded,
   * and the case worth measuring most is the dep dir that raced twice and was
   * declined — see `DepDirPublishOutcome.attempts`.
   */
  progress: { attempts: number };
}): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    args.progress.attempts = attempt;
    try {
      const stream = await args.fetchSnapshot(args.workerUrl, args.depDir, args.signal);
      await args.extract(stream, args.destDir);
      return;
    } catch (err) {
      if (attempt >= SNAPSHOT_ATTEMPTS || args.signal?.aborted) throw err;
      // A partial tree from the failed attempt must not be mixed into the retry's —
      // extraction recreates the dir, it does not clear it. Recreated here rather
      // than left to the extractor, so the invariant does not depend on which one
      // is injected.
      fs.rmSync(args.destDir, { recursive: true, force: true });
      fs.mkdirSync(args.destDir, { recursive: true });
      console.warn(
        `[overlay-publish] snapshot attempt ${attempt}/${SNAPSHOT_ATTEMPTS} failed for ${args.depDir}, retrying:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

/**
 * Publish each declared dep dir's post-install snapshot as the next rolling base
 * for its `(repo, runtime, dep-dir)` scope. Returns one outcome per *candidate*
 * dep dir (empty when the feature is off / the session is ineligible / nothing is
 * overlay-worthy). Never throws for a per-dir failure — that dir gets an `"error"`
 * outcome and the rest proceed.
 */
export async function publishDepDirOverlayBases(
  args: OverlayPublishArgs,
  deps: OverlayPublishDeps,
): Promise<DepDirPublishOutcome[]> {
  const env = deps.env ?? process.env;
  if (!isOverlayEnabled(env)) return [];

  const { workspaceDir } = args.session;
  if (!workspaceDir) return [];

  // docs/248 — the scope must be computed with the workspace in hand: a repo
  // whose Node pin moves it off the image's Node publishes into its own base,
  // never into the one built under the image's ABI.
  const scope = resolveOverlayScope(args.session, env, workspaceDir);
  if (!scope) return [];

  // docs/198 — pnpm repos never overlay (the mount side skips them in
  // `prepareOverlaySpecs`), so they have no per-dep-dir base to publish. Skip them
  // here too, at the SAME single decision point (`isPnpmRepo`) the mount side uses —
  // otherwise this hook publishes a never-mounted base generation (a 480 MB
  // export, observed leaking on the canary 2026-06-12). One detector, both sides.
  if (isPnpmRepo(workspaceDir)) return [];

  const valid = await validDepDirsForOverlay(depDirsForSession(args.session), workspaceDir);
  if (valid.length === 0) return [];

  // A failed install is never a base — decline every dep dir before any I/O.
  // (publishBase would skip-ineligible on exitCode anyway; this just avoids the
  // pointless snapshot pull.)
  if (!args.installOk) {
    return valid.map((depDir) => ({ depDir, outcome: "skipped-ineligible" as const }));
  }

  const fetchHeadInfo = deps.fetchHeadInfo ?? fetchWorkspaceHeadInfo;
  const fetchSnapshot = deps.fetchSnapshot ?? fetchDepSnapshotStream;
  const extract = deps.extract ?? extractTarStream;

  // Without the source commit we can't stamp a candidate — decline conservatively.
  const headInfo = await fetchHeadInfo(args.workerUrl, args.signal);
  if (!headInfo) {
    return valid.map((depDir) => ({ depDir, outcome: "skipped-ineligible" as const }));
  }
  const commit = headInfo.commit;
  // Marker ingredients for the base-hit pre-stamp — only when both halves exist.
  // docs/198 — also record the dependency content key (`depsHash`) so a LATER
  // session on a DIFFERENT commit whose dep files are byte-identical can be
  // content-key pre-stamped against this base (the "main advanced by a non-dep
  // commit" scenario). `installInputs` honors an `agent.install-inputs` override,
  // mirroring the worker's own gate; an unreadable config falls back to the
  // command-derived inputs. A null hash (content-keying off / no input files)
  // simply never content-matches — degrading to the exact-commit path.
  let markerStamp: { runtimeKey: string; installCommands: string[]; depsHash: string | null } | undefined;
  if (headInfo.runtimeKey && args.installCommands && args.installCommands.length > 0) {
    let installInputs: string[] | null = null;
    try {
      installInputs = resolveShipitConfig(workspaceDir).agent.installInputs;
    } catch {
      /* unreadable/invalid config — fall back to command-derived inputs */
    }
    markerStamp = {
      runtimeKey: headInfo.runtimeKey,
      installCommands: args.installCommands,
      depsHash: computeInstallDepsHash(workspaceDir, args.installCommands, installInputs),
    };
  }

  const repoGit = deps.createRepoGit(deps.getBareCacheDir(scope.repoUrl));
  const currentDefaultCommit = (await repoGit.resolveDefaultBranchCommit()) ?? undefined;
  const sourceIsDefaultBranch = !!currentDefaultCommit && commit === currentDefaultCommit;
  const isAncestor = repoGit.isAncestor.bind(repoGit);

  const tmpRoot = deps.tmpRoot ?? os.tmpdir();
  const outcomes: DepDirPublishOutcome[] = [];
  for (const depDir of valid) {
    // The container may have been destroyed while an earlier dir was streaming —
    // don't start another multi-hundred-MB pull against a dead worker.
    if (args.signal?.aborted) {
      outcomes.push({ depDir, outcome: "error", error: "publish aborted (session disposed)" });
      continue;
    }
    let tmpDir: string | null = null;
    // Mutable so the count is readable from BOTH the success path below and the
    // catch — a dep dir that raced on every attempt is the one worth counting.
    const pull = { attempts: 0 };
    try {
      tmpDir = fs.mkdtempSync(path.join(tmpRoot, "ovl-pub-"));
      await pullSnapshotWithRetry({
        workerUrl: args.workerUrl,
        depDir,
        destDir: tmpDir,
        fetchSnapshot,
        extract,
        progress: pull,
        ...(args.signal ? { signal: args.signal } : {}),
      });
      // Never publish an empty snapshot. A legitimate post-install dep dir is
      // never empty (npm/pnpm always materialize at least a lockfile shadow);
      // an empty export means the worker's merged view was empty or broken —
      // e.g. a wrongly-skipped install over a fresh overlay, or the readdir
      // breakage a base swap inflicts on live same-scope mounts. Publishing it
      // would install an empty base under the scope's pointer, which the
      // equal-commit skip then makes permanent. Decline instead.
      if (fs.readdirSync(tmpDir).length === 0) {
        outcomes.push({ depDir, outcome: "skipped-empty", attempts: pull.attempts });
        continue;
      }
      const res = await publishBase({
        stateDir: deps.stateDir,
        scope: { ...scope, depDir },
        candidate: {
          commit,
          exitCode: 0,
          preUserInstall: true,
          sourceIsDefaultBranch,
          snapshotDir: tmpDir,
          ...(markerStamp ? { markerStamp } : {}),
        },
        isAncestor,
        currentDefaultCommit,
      });
      outcomes.push({
        depDir,
        outcome: res.outcome,
        depth: res.pointer?.depth,
        generation: res.pointer?.generation,
        attempts: pull.attempts,
      });
    } catch (err) {
      outcomes.push({
        depDir,
        outcome: "error",
        error: err instanceof Error ? err.message : String(err),
        // Zero when the throw came from `mkdtempSync`, before any pull started.
        ...(pull.attempts > 0 ? { attempts: pull.attempts } : {}),
      });
    } finally {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// Measurement instrumentation (docs/183 Phase 7 — warm-install tuning)
// ---------------------------------------------------------------------------

/**
 * Format a single greppable measurement line for an overlay session's
 * install + publish, so the warm-vs-cold / depth-cap data can be tabulated off
 * service logs without a metrics backend. Only emitted when overlay is active
 * (the caller gates on a non-empty outcome list, which only happens with the
 * flag on and the session eligible), so it is inert in production by default.
 *
 * Shape (stable for log parsing — `grep '\[overlay-measure\]' | ...`):
 *
 *   [overlay-measure] session=<id> repo=<url> install_ok=<bool> install_ms=<n> \
 *     dirs=<depDir>:<outcome>[:d<depth>g<generation>][:a<attempts>],...
 *
 * `install_ms` is the orchestrator-observed wall-clock from install kickoff to
 * resolve — a marker-skip (deps already materialized / "main unchanged") resolves
 * in ~tens of ms, a real install in seconds, so duration alone classifies the
 * scenario; the per-dir `d<depth>g<generation>` segment gives the publish result
 * and the overlay depth that drives the depth-cap decision.
 *
 * The `a<attempts>` segment is emitted **only when the retry fired** (`attempts > 1`),
 * so an ordinary run's line is byte-identical to before and `grep ':a'` counts the
 * dep dirs that raced a concurrent write. Each segment is independently optional and
 * self-identifying by its leading letter, which is what keeps the grammar parseable
 * as segments are added — an error dir carries no pointer and so renders `:a2` with
 * no `d…g…` before it.
 */
export function formatOverlayMeasurement(args: {
  sessionId: string;
  repoUrl: string;
  installOk: boolean;
  installDurationMs: number;
  outcomes: DepDirPublishOutcome[];
}): string {
  const dirs = args.outcomes
    .map((o) => {
      const depth = o.depth !== undefined ? `:d${o.depth}g${o.generation ?? "?"}` : "";
      const attempts = o.attempts !== undefined && o.attempts > 1 ? `:a${o.attempts}` : "";
      return `${o.depDir}:${o.outcome}${depth}${attempts}`;
    })
    .join(",");
  return (
    `[overlay-measure] session=${args.sessionId} repo=${args.repoUrl} ` +
    `install_ok=${args.installOk} install_ms=${args.installDurationMs} dirs=${dirs}`
  );
}
