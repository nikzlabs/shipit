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
  outcome: PublishOutcome | "error" | "skipped-empty";
  error?: string;
  depth?: number;
  generation?: number;
  attempts?: number;
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

  if (isPnpmRepo(workspaceDir)) return [];

  const valid = await validDepDirsForOverlay(depDirsForSession(args.session), workspaceDir);
  if (valid.length === 0) return [];

  if (!args.installOk) {
    return valid.map((depDir) => ({ depDir, outcome: "skipped-ineligible" as const }));
  }

  const fetchHeadInfo = deps.fetchHeadInfo ?? fetchWorkspaceHeadInfo;
  const fetchSnapshot = deps.fetchSnapshot ?? fetchDepSnapshotStream;
  const extract = deps.extract ?? extractTarStream;

  const headInfo = await fetchHeadInfo(args.workerUrl, args.signal);
  if (!headInfo) {
    return valid.map((depDir) => ({ depDir, outcome: "skipped-ineligible" as const }));
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
  return outcomes;
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
