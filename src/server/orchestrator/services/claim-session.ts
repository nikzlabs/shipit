import { existsSync, unlinkSync } from "node:fs";
import { sessionStateDirForWorkspace, sessionSharedStateDir, INSTALL_MARKER_FILE } from "../session-state-dir.js";
import { rm } from "node:fs/promises";
import path from "node:path";
import { safeSimpleGit } from "../../shared/git-hooks-guard.js";
import { gitRemoteCredentialResolver } from "./github.js";
import type { SessionManager } from "../sessions.js";
import type { GitManager } from "../../shared/git.js";
import type { RepoGit } from "../repo-git.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { RepoStore } from "../repo-store.js";
import type { SessionContainerManager } from "../session-container.js";
import type { EgressAllowlistStore } from "../egress-allowlist-store.js";
import { ServiceError } from "./types.js";
import {
  generateBranchPrefix,
  fetchAndResolveDefaultBranch,
  isWorkspaceCloneInSyncWithCache,
  syncLocalDefaultBranchToOrigin,
} from "../git-utils.js";
import { ensureBareCache } from "../repo-git.js";
import { getErrorMessage } from "../../shared/utils.js";
import { handWorkspaceBackToWorker } from "../session-worker-uid.js";
import { materializeLfsWithWarning } from "../git-lfs.js";

export interface ClaimSessionDeps {
  sessionManager: SessionManager;
  repoStore: RepoStore;
  createGitManager: (dir: string) => GitManager;
  createRepoGit: (dir: string) => RepoGit;
  githubAuthManager: GitHubAuthManager;
  getSharedRepoDir: (repoUrl: string) => string;
  createSessionDirFull: (title: string) => Promise<{
    appSessionId: string;
    sessionDir: string;
    workspaceDir: string;
  }>;
  sseBroadcast: (event: string, data: unknown) => void;
  warmSessionForRepo?: (repoUrl: string) => Promise<void>;
  waitForWarmSession?: (repoUrl: string) => Promise<void> | undefined;
  shouldSkipClaimFetch?: (repoUrl: string) => boolean;
  containerManager?: SessionContainerManager;
  egressAllowlistStore?: EgressAllowlistStore;
}

export interface ClaimSessionResult {
  sessionId: string;
  workspaceDir: string;
  fetchDurationMs: number;
  claimPath: "reuse" | "warm" | "waiting" | "slow-clone";
}

export interface ClaimSessionOptions {
  isCancelled?: () => boolean;
  /** Bypass recent-cache fetch skipping, so children can see newly merged commits. */
  forceFetch?: boolean;
  /** Exclude the spawning parent to prevent claiming and resetting its live workspace. */
  excludeSessionIds?: string[];
  /** Required for background claims: warm drafts may still have an attached user. */
  skipReuse?: boolean;
}

export class ClaimAbortedError extends Error {
  constructor() {
    super("Claim aborted by caller");
    this.name = "ClaimAbortedError";
  }
}

export interface ClaimSessionService {
  claim(url: string, opts?: ClaimSessionOptions): Promise<ClaimSessionResult>;
}

// Share one instance across callers so claims for the same repository serialize.
export function createClaimSessionService(deps: ClaimSessionDeps): ClaimSessionService {
  const claimChains = new Map<string, Promise<unknown>>();
  async function serializeClaim<T>(repoUrl: string, fn: () => Promise<T>): Promise<T> {
    const prev = claimChains.get(repoUrl) ?? Promise.resolve();
    // eslint-disable-next-line no-restricted-syntax -- intentional two-arg .then for promise chaining
    const next = prev.then(fn, fn);
    claimChains.set(repoUrl, next);
    try {
      return await next;
    } finally {
      if (claimChains.get(repoUrl) === next) claimChains.delete(repoUrl);
    }
  }

  function warnIfStaleClaimFetch(fetched: boolean, url: string): void {
    if (fetched) return;
    console.warn(`[claim-session] Workspace fetch failed for ${url} — using the existing clone, which may be stale`);
    deps.sseBroadcast("error", {
      message: `Claimed session for ${url} may be based on stale code — could not fetch the latest commits.`,
    });
  }

  async function refreshCloneToLatestMain(
    sessionDir: string,
    repoLabel: string,
    onAuthError?: (err: Error) => void,
  ): Promise<{ headChanged: boolean; fetched: boolean; fetchDurationMs: number }> {
    const sessionGit = deps.createGitManager(sessionDir);
    const headBefore = await sessionGit.getHeadHash();
    if (deps.githubAuthManager.authenticated) {
      deps.githubAuthManager.configureGitCredentials(sessionDir);
    }
    const { resetTarget, fetched, fetchDurationMs } = await fetchAndResolveDefaultBranch(
      sessionDir,
      onAuthError,
      { resolveRemoteCredential: gitRemoteCredentialResolver(deps.githubAuthManager) },
    );
    if (resetTarget) {
      await sessionGit.rollback(resetTarget);
    }
    // Keep local-base PR comparisons aligned with the remote base.
    await syncLocalDefaultBranchToOrigin(sessionDir);
    // Reset writes LFS pointers with smudge disabled. Always materialize, including
    // claims without a reset target, to repair stubs from earlier failed pulls.
    await materializeLfsWithWarning(sessionDir, repoLabel, (message) =>
      deps.sseBroadcast("error", { message }),
    );
    handWorkspaceBackToWorker(sessionDir);
    const headAfter = await sessionGit.getHeadHash();
    const headChanged = headBefore !== headAfter;
    if (headChanged) {
      const stateDir = sessionStateDirForWorkspace(sessionDir);
      try { unlinkSync(path.join(sessionSharedStateDir(stateDir), INSTALL_MARKER_FILE)); } catch { /* marker may not exist */ }
    }
    return { headChanged, fetched, fetchDurationMs };
  }

  async function refreshClaimedSession(
    url: string,
    workspaceDir: string,
    forceFetch: boolean,
  ): Promise<number> {
    if (
      !forceFetch &&
      deps.shouldSkipClaimFetch?.(url) &&
      (await isWorkspaceCloneInSyncWithCache(workspaceDir, deps.getSharedRepoDir(url)))
    ) {
      return 0;
    }
    try {
      const r = await refreshCloneToLatestMain(
        workspaceDir,
        url,
        (err) => deps.githubAuthManager.markTokenInvalid(`claim-session refresh failed for ${url}: ${err.message}`),
      );
      warnIfStaleClaimFetch(r.fetched, url);
      return r.fetchDurationMs;
    } catch (err) {
      console.error(`[claim-session] Failed to refresh clone to latest main:`, getErrorMessage(err));
      return 0;
    }
  }

  function rewarmPool(url: string): void {
    if (deps.warmSessionForRepo) void deps.warmSessionForRepo(url);
  }

  return {
    async claim(url, opts): Promise<ClaimSessionResult> {
      const repo = deps.repoStore.get(url);
      if (!repo) throw new ServiceError(404, "Repository not found");
      if (repo.status !== "ready") throw new ServiceError(400, "Repository is still cloning");

      const claimStart = Date.now();
      let claimPath: ClaimSessionResult["claimPath"] = "slow-clone";
      const forceFetch = opts?.forceFetch === true;
      const skipReuse = opts?.skipReuse === true;
      const excluded = new Set(opts?.excludeSessionIds ?? []);

      const result = await serializeClaim(url, async () => {
        const inFlightWarming = deps.waitForWarmSession?.(url);
        if (inFlightWarming) await inFlightWarming;

        // Warming can change the pool pointer during the await.
        const repoAfterWarm = deps.repoStore.get(url) ?? repo;

        const reusable = skipReuse
          ? undefined
          : deps.sessionManager.findUngraduatedWarm(url, repoAfterWarm.warmSessionId ?? undefined);
        // Clearing a network override would leave its old container topology running.
        const carriedOverride = reusable
          ? deps.egressAllowlistStore?.getSessionOverride(reusable.id) ?? null
          : null;
        if (
          reusable?.workspaceDir &&
          !excluded.has(reusable.id) &&
          carriedOverride === null &&
          existsSync(path.join(reusable.workspaceDir, ".git"))
        ) {
          claimPath = "reuse";
          const fetchDurationMs = await refreshClaimedSession(url, reusable.workspaceDir, forceFetch);
          return { sessionId: reusable.id, workspaceDir: reusable.workspaceDir, fetchDurationMs };
        }

        const currentRepo = deps.repoStore.get(url);
        if (currentRepo?.warmSessionId && !excluded.has(currentRepo.warmSessionId)) {
          const warmSession = deps.sessionManager.get(currentRepo.warmSessionId);
          if (warmSession?.workspaceDir) {
            claimPath = "warm";
            const sessionId = currentRepo.warmSessionId;
            deps.repoStore.setWarmSessionId(url, undefined);
            const fetchDurationMs = await refreshClaimedSession(url, warmSession.workspaceDir, forceFetch);
            rewarmPool(url);
            return { sessionId, workspaceDir: warmSession.workspaceDir, fetchDurationMs };
          }
        }

        const warmingPromise = deps.waitForWarmSession?.(url);
        if (warmingPromise) {
          await warmingPromise;
          const freshRepo = deps.repoStore.get(url);
          if (freshRepo?.warmSessionId && !excluded.has(freshRepo.warmSessionId)) {
            const warmSession = deps.sessionManager.get(freshRepo.warmSessionId);
            if (warmSession?.workspaceDir) {
              claimPath = "waiting";
              const sessionId = freshRepo.warmSessionId;
              deps.repoStore.setWarmSessionId(url, undefined);
              const fetchDurationMs = await refreshClaimedSession(url, warmSession.workspaceDir, forceFetch);
              rewarmPool(url);
              return { sessionId, workspaceDir: warmSession.workspaceDir, fetchDurationMs };
            }
          }
        }

        claimPath = "slow-clone";
        if (opts?.isCancelled?.()) throw new ClaimAbortedError();
        const cacheDir = deps.getSharedRepoDir(url);
        const branchPrefix = generateBranchPrefix();
        const created = await deps.createSessionDirFull("Warm session");
        const { appSessionId, workspaceDir } = created;

        await rm(workspaceDir, { recursive: true, force: true });

        const { git: cacheGit } = await ensureBareCache(cacheDir, url, deps.createRepoGit);

        if (deps.githubAuthManager.authenticated) {
          await cacheGit.setRemoteUrl(url);
        }

        try {
          await cacheGit.fetchCache();
        } catch (err) {
          // The workspace fetch below can still refresh a stale cache clone.
          console.error(`[claim-session] Fetch cache failed for ${url}:`, getErrorMessage(err));
          deps.sseBroadcast("error", {
            message: `Repository cache for ${url} could not be refreshed: ${getErrorMessage(err)}`,
          });
        }

        await cacheGit.cloneFromCache(workspaceDir, url);

        if (deps.githubAuthManager.authenticated) {
          deps.githubAuthManager.configureGitCredentials(workspaceDir);
        }

        const skipFetch = !forceFetch && (deps.shouldSkipClaimFetch?.(url) ?? false);
        const { resetTarget, fetched, fetchDurationMs, authError } = await fetchAndResolveDefaultBranch(
          workspaceDir,
          (err) => deps.githubAuthManager.markTokenInvalid(`claim-session fetch failed for ${url}: ${err.message}`),
          { skipFetch, resolveRemoteCredential: gitRemoteCredentialResolver(deps.githubAuthManager) },
        );
        if (!skipFetch && !fetched && !authError) {
          console.warn(`[claim-session] Workspace fetch failed for ${url} — branching from the bare-cache snapshot, which may be stale`);
          deps.sseBroadcast("error", {
            message: `Claimed session for ${url} may be based on stale code — could not fetch the latest commits.`,
          });
        }
        const branchArgs = ["checkout", "-b", branchPrefix];
        if (resetTarget) branchArgs.push(resetTarget);
        await safeSimpleGit(workspaceDir).raw(branchArgs);

        await syncLocalDefaultBranchToOrigin(workspaceDir);
        // Materialize after checkout, which writes LFS pointer stubs.
        await materializeLfsWithWarning(workspaceDir, url, (message) =>
          deps.sseBroadcast("error", { message }),
        );
        handWorkspaceBackToWorker(workspaceDir);

        deps.sessionManager.setRemoteUrl(appSessionId, url);
        deps.sessionManager.setBranch(appSessionId, branchPrefix);
        deps.sessionManager.setWarm(appSessionId, true);

        rewarmPool(url);

        return { sessionId: appSessionId, workspaceDir, fetchDurationMs };
      });

      // Exclude clone-time file writes from the docs viewer's session-modified group.
      deps.sessionManager.markStarted(result.sessionId);

      // Opening a workspace counts as use even if it never receives a first turn.
      deps.repoStore.touch(url);

      // Inspect Docker: a warm-pool pointer can survive a missed container die event.
      const standbyRunning = await deps.containerManager?.isTrackedContainerRunning(result.sessionId);
      const standby = standbyRunning === true ? "ready"
        : standbyRunning === false ? "missing"
        : "unknown";
      console.log(
        `[timing] claim-session for ${url} path=${claimPath} standby=${standby} ` +
          `total=${Date.now() - claimStart}ms fetch=${result.fetchDurationMs}ms`,
      );

      return { ...result, claimPath };
    },
  };
}
