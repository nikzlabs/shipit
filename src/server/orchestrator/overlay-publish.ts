import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";

import type { SessionInfo } from "../shared/types.js";
import { resolveShipitConfig } from "../shared/shipit-config.js";
import { computeInstallDepsHash, hasInstallLifecycleScript } from "../shared/deps-hash.js";
import {
  isOverlayEnabled,
  isPnpmRepo,
  resolveOverlayScope,
  depDirsForSession,
  classifyDepDirsForOverlay,
  PNPM_VERIFIED_NAMESPACE,
  PNPM_BASE_DEP_DIR,
  type DepDirDropReason,
} from "./overlay-session.js";
import {
  publishBase,
  readBasePointerByHash,
  type OverlayScope,
  type PublishOutcome,
} from "./overlay-base.js";
import { overlayScopeHash } from "./overlay-volume.js";
import type { PnpmBaseBuildOutcome, PnpmBaseBuildRequest } from "./pnpm-base-builder.js";
import {
  extractTarStream,
  fetchDepSnapshotStream,
  fetchWorkspaceHeadInfo,
  type WorkspaceHeadInfo,
} from "./overlay-snapshot.js";
import type { RepoGit } from "./repo-git.js";

export type AncestryOracle = Pick<RepoGit, "isAncestor" | "resolveDefaultBranchCommit">;

export interface OverlayPublishDeps {
  stateDir: string;
  createRepoGit: (repoDir: string) => AncestryOracle;
  getBareCacheDir: (repoUrl: string) => string;
  env?: NodeJS.ProcessEnv;
  fetchSnapshot?: (workerUrl: string, depDir: string, signal?: AbortSignal) => Promise<Readable>;
  fetchHeadInfo?: (workerUrl: string, signal?: AbortSignal) => Promise<WorkspaceHeadInfo | null>;
  extract?: (stream: Readable, destDir: string) => Promise<void>;
  tmpRoot?: string;
  /**
   * Builds and publishes the verified pnpm base (`buildVerifiedPnpmBase`). Absent — no Docker —
   * means a pnpm repo gets no base and installs privately, exactly as it did before the trigger.
   */
  buildPnpmBase?: (req: PnpmBaseBuildRequest) => Promise<PnpmBaseBuildOutcome>;
}

export interface OverlayPublishArgs {
  session: Pick<SessionInfo, "remoteUrl" | "kind" | "workspaceDir">;
  workerUrl: string;
  installOk: boolean;
  installCommands?: string[];
  signal?: AbortSignal;
}

export interface DepDirPublishOutcome {
  depDir: string;
  outcome:
    | PublishOutcome
    | "error"
    | "skipped-empty"
    | "dropped"
    // The verified pnpm base: a candidate that failed registry verification, a build that did not
    // finish, and a trigger that found one already running. None fails the session's own install.
    | "skipped-unverified"
    | "build-failed"
    | "skipped-building";
  error?: string;
  // Why a pnpm trigger produced no base. Logged rather than rendered into the measurement line.
  detail?: string;
  // Set on "skipped-unverified": the first lockfile package whose digests disagreed.
  failedPackage?: string;
  depth?: number;
  generation?: number;
  attempts?: number;
  // Set only on "dropped": the declared dir got no overlay at all, so nothing restores it.
  dropReason?: DepDirDropReason;
}

// A dev server's one-time cache write can invalidate tar's first snapshot; retry the whole read.
const SNAPSHOT_ATTEMPTS = 2;

async function pullSnapshotWithRetry(args: {
  workerUrl: string;
  depDir: string;
  destDir: string;
  fetchSnapshot: (workerUrl: string, depDir: string, signal?: AbortSignal) => Promise<Readable>;
  extract: (stream: Readable, destDir: string) => Promise<void>;
  signal?: AbortSignal;
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
      // Extraction does not clear old files; discard the failed attempt's partial tree.
      fs.rmSync(args.destDir, { recursive: true, force: true });
      fs.mkdirSync(args.destDir, { recursive: true });
      console.warn(
        `[overlay-publish] snapshot attempt ${attempt}/${SNAPSHOT_ATTEMPTS} failed for ${args.depDir}, retrying:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

export async function publishDepDirOverlayBases(
  args: OverlayPublishArgs,
  deps: OverlayPublishDeps,
): Promise<DepDirPublishOutcome[]> {
  const env = deps.env ?? process.env;
  if (!isOverlayEnabled(env)) return [];

  const { workspaceDir } = args.session;
  if (!workspaceDir) return [];

  const scope = resolveOverlayScope(args.session, env, workspaceDir);
  if (!scope) return [];

  const eligibility = await classifyDepDirsForOverlay(depDirsForSession(args.session), workspaceDir);
  const valid = eligibility.valid;
  // Report drops rather than omitting them: a silently missing dir was only visible by diffing
  // two sessions' measurement lines (docs/183 FINDINGS, 2026-09-15).
  const dropped: DepDirPublishOutcome[] = eligibility.dropped.map((d) => ({
    depDir: d.depDir,
    outcome: "dropped" as const,
    dropReason: d.reason,
  }));

  if (isPnpmRepo(workspaceDir)) {
    return [...(await publishVerifiedPnpmBase(args, deps, scope, valid)), ...dropped];
  }

  if (valid.length === 0) return dropped;

  if (!args.installOk) {
    return [...valid.map((depDir) => ({ depDir, outcome: "skipped-ineligible" as const })), ...dropped];
  }

  const fetchHeadInfo = deps.fetchHeadInfo ?? fetchWorkspaceHeadInfo;
  const fetchSnapshot = deps.fetchSnapshot ?? fetchDepSnapshotStream;
  const extract = deps.extract ?? extractTarStream;

  const headInfo = await fetchHeadInfo(args.workerUrl, args.signal);
  if (!headInfo) {
    return [...valid.map((depDir) => ({ depDir, outcome: "skipped-ineligible" as const })), ...dropped];
  }
  const commit = headInfo.commit;
  let markerStamp: { runtimeKey: string; installCommands: string[]; depsHash: string | null } | undefined;
  let contentKeyDescribesTree = false;
  if (headInfo.runtimeKey && args.installCommands && args.installCommands.length > 0) {
    let installInputs: string[] | null = null;
    try {
      installInputs = resolveShipitConfig(workspaceDir).agent.installInputs;
    } catch {
      /* Fall back to command-derived inputs. */
    }
    markerStamp = {
      runtimeKey: headInfo.runtimeKey,
      installCommands: args.installCommands,
      depsHash: computeInstallDepsHash(workspaceDir, args.installCommands, installInputs),
    };
    // Lifecycle scripts may read unhashed files; reuse requires an explicit input list in that case.
    contentKeyDescribesTree =
      (installInputs !== null && installInputs.length > 0) || !hasInstallLifecycleScript(workspaceDir);
  }

  const repoGit = deps.createRepoGit(deps.getBareCacheDir(scope.repoUrl));
  const currentDefaultCommit = (await repoGit.resolveDefaultBranchCommit()) ?? undefined;
  const sourceIsDefaultBranch = !!currentDefaultCommit && commit === currentDefaultCommit;
  const isAncestor = repoGit.isAncestor.bind(repoGit);

  const tmpRoot = deps.tmpRoot ?? os.tmpdir();
  const outcomes: DepDirPublishOutcome[] = [];
  for (const depDir of valid) {
    if (args.signal?.aborted) {
      outcomes.push({ depDir, outcome: "error", error: "publish aborted (session disposed)" });
      continue;
    }
    let tmpDir: string | null = null;
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
      // A broken merged view can export an empty tree; never publish it as an installed base.
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
          contentKeyDescribesTree,
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
        ...(pull.attempts > 0 ? { attempts: pull.attempts } : {}),
      });
    } finally {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
  return [...outcomes, ...dropped];
}

/**
 * The pnpm branch: the base is BUILT by the orchestrator from the default-branch commit's
 * committed inputs, never pulled from the session's `node_modules`
 * (docs/276-shared-package-cache-integrity plan.md section 5; reqs 1, 3, 6).
 *
 * The trigger is docs/183's, unchanged — a successful declared install on the default branch —
 * and nothing here can fail that install (req 9): every path that cannot produce a base reports
 * an outcome and leaves the session with its own private tree.
 */
async function publishVerifiedPnpmBase(
  args: OverlayPublishArgs,
  deps: OverlayPublishDeps,
  scope: OverlayScope,
  valid: string[],
): Promise<DepDirPublishOutcome[]> {
  const depDir = PNPM_BASE_DEP_DIR;
  if (valid.length === 0) return [];

  const unsupported = valid.filter((d) => d !== depDir);
  if (unsupported.length > 0) {
    // The builder produces exactly one tree — pnpm's own `node_modules` — and the mount gate is
    // all-or-nothing across declared dep dirs, so publishing it alone could never be mounted.
    const detail =
      `the verified pnpm builder produces only ${depDir}; agent.dep-dirs also declares ${unsupported.join(", ")}`;
    return valid.map((d) => ({ depDir: d, outcome: "skipped-ineligible" as const, detail }));
  }

  // No builder wired (no Docker): a pnpm repo installs privately, exactly as it did before.
  const build = deps.buildPnpmBase;
  if (!build) return [];
  if (!args.installOk) return [{ depDir, outcome: "skipped-ineligible" }];

  const fetchHeadInfo = deps.fetchHeadInfo ?? fetchWorkspaceHeadInfo;
  const headInfo = await fetchHeadInfo(args.workerUrl, args.signal);
  if (!headInfo) return [{ depDir, outcome: "skipped-ineligible" }];

  const repoDir = deps.getBareCacheDir(scope.repoUrl);
  const repoGit = deps.createRepoGit(repoDir);
  const defaultBranchCommit = await repoGit.resolveDefaultBranchCommit();
  if (!defaultBranchCommit || headInfo.commit !== defaultBranchCommit) {
    return [{ depDir, outcome: "skipped-ineligible" }];
  }

  // Every session's install triggers, so read what is already published before spending a builder
  // container on it: `publishBase` would answer `skipped-equal` for this commit anyway. The read is
  // an optimization, not the decision — the compare-and-swap inside the publish is.
  const scopeHash = overlayScopeHash(
    scope.repoUrl,
    scope.runtimeKey,
    depDir,
    PNPM_VERIFIED_NAMESPACE,
  );
  // A pointer whose generation directory the sweep took is NOT a base — `publishBase` repairs that
  // case, so the shortcut must not run ahead of it or the scope never gets a base again.
  const current = readBasePointerByHash(deps.stateDir, scopeHash);
  if (current?.commit === defaultBranchCommit && fs.existsSync(current.baseDir)) {
    return [{ depDir, outcome: "skipped-equal", generation: current.generation }];
  }

  // Deliberately no abort signal: the build's inputs are staged out of the bare cache and its
  // registry is the orchestrator's, so a build that outlives its triggering session simply
  // finishes and publishes (plan.md section 5, "no runner-bound cancellation").
  try {
    const outcome = await build({
      repoDir,
      defaultBranchCommit,
      scope: { ...scope, depDir, namespace: PNPM_VERIFIED_NAMESPACE },
      isAncestor: repoGit.isAncestor.bind(repoGit),
    });
    return [describePnpmBuild(depDir, outcome, scope.repoUrl)];
  } catch (err) {
    // Docker, the filesystem and the publish can all throw. Reported like the npm path's failures
    // rather than left to the caller's catch, which would lose the measurement line with it.
    return [{ depDir, outcome: "error", error: err instanceof Error ? err.message : String(err) }];
  }
}

function describePnpmBuild(
  depDir: string,
  outcome: PnpmBaseBuildOutcome,
  repoUrl: string,
): DepDirPublishOutcome {
  switch (outcome.status) {
    case "published":
      return {
        depDir,
        outcome: outcome.outcome,
        ...(outcome.generation !== null ? { generation: outcome.generation } : {}),
      };
    case "verification-failed":
      console.warn(
        `[overlay-publish] verified pnpm base for ${repoUrl} not published — ` +
        `${outcome.failedPackage} failed verification: ${outcome.detail}`,
      );
      return {
        depDir,
        outcome: "skipped-unverified",
        failedPackage: outcome.failedPackage,
        detail: outcome.detail,
      };
    case "build-failed":
      console.warn(`[overlay-publish] verified pnpm base build for ${repoUrl} failed: ${outcome.detail}`);
      return { depDir, outcome: "build-failed", detail: outcome.detail };
    case "skipped-building":
      return { depDir, outcome: "skipped-building", detail: outcome.detail };
    case "ineligible":
      console.log(`[overlay-publish] no verified pnpm base for ${repoUrl}: ${outcome.detail}`);
      return { depDir, outcome: "skipped-ineligible", detail: outcome.detail };
  }
}

export function formatOverlayMeasurement(args: {
  sessionId: string;
  repoUrl: string;
  installOk: boolean;
  installDurationMs: number;
  outcomes: DepDirPublishOutcome[];
}): string {
  const dirs = args.outcomes
    .map((o) => {
      const depth =
        o.depth !== undefined
          ? `:d${o.depth}g${o.generation ?? "?"}`
          // The verified pnpm base carries a generation and no depth: every generation is a whole
          // tree the orchestrator built, so nothing counts lineage depth for it.
          : o.generation !== undefined ? `:g${o.generation}` : "";
      const attempts = o.attempts !== undefined && o.attempts > 1 ? `:a${o.attempts}` : "";
      const drop = o.dropReason !== undefined ? `:${o.dropReason}` : "";
      const failed = o.failedPackage !== undefined ? `:${o.failedPackage}` : "";
      return `${o.depDir}:${o.outcome}${drop}${failed}${depth}${attempts}`;
    })
    .join(",");
  return (
    `[overlay-measure] session=${args.sessionId} repo=${args.repoUrl} ` +
    `install_ok=${args.installOk} install_ms=${args.installDurationMs} dirs=${dirs}`
  );
}
