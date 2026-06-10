/**
 * Overlay dep store — publish-after-install orchestration (docs/183 Phase 4b).
 *
 * The seam that turns a finished install into the next shared rolling base, **per
 * declared dep dir**. It composes the three lower layers built earlier:
 *
 *   - `overlay-session.ts` — eligibility + the per-dep-dir scope (`resolveOverlayScope`,
 *     `depDirsForSession`, `validDepDirsForOverlay`).
 *   - `overlay-snapshot.ts` — the worker pull + tar extraction (`fetchDepSnapshotStream`,
 *     `extractTarStream`, `fetchWorkspaceHeadCommit`).
 *   - `overlay-base.ts` — the publish compare-and-swap (`publishBase`), reused
 *     **unchanged**: only the caller and the per-dep-dir granularity are new here.
 *
 * Wiring lives at the install-completion seam (`service-manager-setup.ts`): after a
 * session's `agent.install` resolves, the runner-adapting hook constructed in
 * `index.ts` calls `publishDepDirOverlayBases` once. The whole module is inert
 * unless `OVERLAY_DEP_STORE` is on AND the session is overlay-eligible — flag-off
 * returns `[]` before any I/O, so non-overlay sessions are byte-for-byte unchanged.
 *
 * Best-effort by construction: a publish never affects the install or the session.
 * The caller swallows a thrown hook; within a dep-dir loop a per-dir failure is
 * recorded as an `"error"` outcome and the other dirs still publish.
 *
 * ## Eligibility (plan §3)
 *
 * A candidate publishes only when its install **exited 0**, was a **pre-user**
 * install, and its **source base is the remote default-branch commit**. We resolve:
 *   - `exitCode` from the install result (`installOk`),
 *   - `commit` from the worker's merged HEAD (`fetchWorkspaceHeadCommit`),
 *   - `currentDefaultCommit` from the bare cache (`RepoGit.resolveDefaultBranchCommit`),
 *   - `sourceIsDefaultBranch = commit === currentDefaultCommit`.
 *
 * `preUserInstall` is `true` here: this hook fires at the setup/activation install
 * seam, before any agent turn has run for the runner, and the `sourceIsDefaultBranch`
 * gate further restricts publishing to an untouched default-branch checkout. The one
 * residual gap (uncommitted dep edits while HEAD still equals the default tip) is
 * acceptable while the flag is off and is hardened in Phase 7.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";

import type { SessionInfo } from "../shared/types.js";
import {
  isOverlayEnabled,
  resolveOverlayScope,
  depDirsForSession,
  validDepDirsForOverlay,
} from "./overlay-session.js";
import { publishBase, type PublishOutcome } from "./overlay-base.js";
import {
  extractTarStream,
  fetchDepSnapshotStream,
  fetchWorkspaceHeadCommit,
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
  fetchSnapshot?: (workerUrl: string, depDir: string) => Promise<Readable>;
  fetchHeadCommit?: (workerUrl: string) => Promise<string | null>;
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
}

/** Per-dep-dir result — the publish CAS outcome, or `"error"` if the dir's pull/extract/publish threw. */
export interface DepDirPublishOutcome {
  depDir: string;
  outcome: PublishOutcome | "error";
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

  const scope = resolveOverlayScope(args.session, env);
  if (!scope) return [];

  const { workspaceDir } = args.session;
  if (!workspaceDir) return [];

  const valid = await validDepDirsForOverlay(depDirsForSession(args.session), workspaceDir);
  if (valid.length === 0) return [];

  // A failed install is never a base — decline every dep dir before any I/O.
  // (publishBase would skip-ineligible on exitCode anyway; this just avoids the
  // pointless snapshot pull.)
  if (!args.installOk) {
    return valid.map((depDir) => ({ depDir, outcome: "skipped-ineligible" as const }));
  }

  const fetchHeadCommit = deps.fetchHeadCommit ?? fetchWorkspaceHeadCommit;
  const fetchSnapshot = deps.fetchSnapshot ?? fetchDepSnapshotStream;
  const extract = deps.extract ?? extractTarStream;

  // Without the source commit we can't stamp a candidate — decline conservatively.
  const commit = await fetchHeadCommit(args.workerUrl);
  if (!commit) {
    return valid.map((depDir) => ({ depDir, outcome: "skipped-ineligible" as const }));
  }

  const repoGit = deps.createRepoGit(deps.getBareCacheDir(scope.repoUrl));
  const currentDefaultCommit = (await repoGit.resolveDefaultBranchCommit()) ?? undefined;
  const sourceIsDefaultBranch = !!currentDefaultCommit && commit === currentDefaultCommit;
  const isAncestor = repoGit.isAncestor.bind(repoGit);

  const tmpRoot = deps.tmpRoot ?? os.tmpdir();
  const outcomes: DepDirPublishOutcome[] = [];
  for (const depDir of valid) {
    let tmpDir: string | null = null;
    try {
      tmpDir = fs.mkdtempSync(path.join(tmpRoot, "ovl-pub-"));
      const stream = await fetchSnapshot(args.workerUrl, depDir);
      await extract(stream, tmpDir);
      const res = await publishBase({
        stateDir: deps.stateDir,
        scope: { ...scope, depDir },
        candidate: {
          commit,
          exitCode: 0,
          preUserInstall: true,
          sourceIsDefaultBranch,
          snapshotDir: tmpDir,
        },
        isAncestor,
        currentDefaultCommit,
      });
      outcomes.push({
        depDir,
        outcome: res.outcome,
        depth: res.pointer?.depth,
        generation: res.pointer?.generation,
      });
    } catch (err) {
      outcomes.push({
        depDir,
        outcome: "error",
        error: err instanceof Error ? err.message : String(err),
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
 *   [overlay-measure] session=<id> repo=<url> install_ok=<bool> install_ms=<n> dirs=node_modules:created:d1g1,...
 *
 * `install_ms` is the orchestrator-observed wall-clock from install kickoff to
 * resolve — a marker-skip (deps already materialized / "main unchanged") resolves
 * in ~tens of ms, a real install in seconds, so duration alone classifies the
 * scenario; the per-dir `outcome:d<depth>g<generation>` suffix gives the publish
 * result and the overlay depth that drives the depth-cap decision.
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
      return `${o.depDir}:${o.outcome}${depth}`;
    })
    .join(",");
  return (
    `[overlay-measure] session=${args.sessionId} repo=${args.repoUrl} ` +
    `install_ok=${args.installOk} install_ms=${args.installDurationMs} dirs=${dirs}`
  );
}
