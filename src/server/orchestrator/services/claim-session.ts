import { existsSync } from "node:fs";
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
  /** The claimed session's pre-started preview, for the timing line (docs/288 req 11). */
  previewState?: (sessionId: string) => string;
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
  /**
   * Never take the warm session: keep it for a person opening a session (docs/288 req 12). A
   * scheduled run also needs a mount its standby lacks (docs/324-scheduled-sessions).
   */
  skipWarm?: boolean;
  /** The claiming browser tab; only the draft this tab was last given is ever reused. */
  tabId?: string;
}

export class ClaimAbortedError extends Error {
  constructor() {
    super("Claim aborted by caller");
    this.name = "ClaimAbortedError";
  }
}

export interface ClaimSessionService {
  claim(url: string, opts?: ClaimSessionOptions): Promise<ClaimSessionResult>;
  /**
   * Bring the repo's warm session up to the default branch while nobody holds it (docs/288 req 13).
   * Runs under the claim lock; null when `sessionId` is no longer the repo's warm session.
   */
  refreshWarm?(url: string, sessionId: string): Promise<{ headChanged: boolean } | null>;
}

async function readCacheHead(cacheDir: string): Promise<string | null> {
  try {
    return (await safeSimpleGit(cacheDir).raw(["rev-parse", "HEAD"])).trim() || null;
  } catch {
    return null;
  }
}

// Share one instance across callers so claims for the same repository serialize.
export function createClaimSessionService(deps: ClaimSessionDeps): Required<ClaimSessionService> {
  const claimChains = new Map<string, Promise<unknown>>();
  // One entry per tab and repository; a tab id lives for one page load, so the oldest entries are dropped.
  const draftByTab = new Map<string, string>();
  const MAX_TAB_DRAFTS = 1000;
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
  ): Promise<{ fetched: boolean; fetchDurationMs: number }> {
    const sessionGit = deps.createGitManager(sessionDir);
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
    // Keep the install marker: the worker re-checks it against the new HEAD and dependency hash, and
    // deleting it forced a reinstall that stopped a warm session's pre-started services (docs/288).
    return { fetched, fetchDurationMs };
  }

  async function refreshClaimedSession(
    url: string,
    workspaceDir: string,
    forceFetch: boolean,
  ): Promise<number> {
    // The caller has taken the session out of the pool by now, so this must fail soft as a whole.
    try {
      if (
        !forceFetch &&
        deps.shouldSkipClaimFetch?.(url) &&
        (await isWorkspaceCloneInSyncWithCache(workspaceDir, deps.getSharedRepoDir(url)))
      ) {
        return 0;
      }
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
    refreshWarm(url: string, sessionId: string): Promise<{ headChanged: boolean } | null> {
      return serializeClaim(url, async () => {
        if (deps.repoStore.get(url)?.warmSessionId !== sessionId) return null;
        const workspaceDir = deps.sessionManager.get(sessionId)?.workspaceDir;
        if (!workspaceDir) return null;
        const sessionGit = deps.createGitManager(workspaceDir);
        const headBefore = await sessionGit.getHeadHash();
        // The prefetcher keeps the bare cache current, so an unmoved cache means nothing to fetch.
        const cacheHead = await readCacheHead(deps.getSharedRepoDir(url));
        if (cacheHead === null || cacheHead === headBefore) return { headChanged: false };
        await refreshCloneToLatestMain(
          workspaceDir,
          url,
          (err) => deps.githubAuthManager.markTokenInvalid(`warm refresh failed for ${url}: ${err.message}`),
        );
        return { headChanged: (await sessionGit.getHeadHash()) !== headBefore };
      });
    },

    async claim(url, opts): Promise<ClaimSessionResult> {
      const repo = deps.repoStore.get(url);
      if (!repo) throw new ServiceError(404, "Repository not found");
      if (repo.status !== "ready") throw new ServiceError(400, "Repository is still cloning");

      // Opening a workspace counts as use. Stamp it first: the claim may re-clone a cache the disk
      // janitor reclaimed, and a stale row lets the janitor delete that clone mid-write.
      deps.repoStore.touch(url);

      const claimStart = Date.now();
      let claimPath: ClaimSessionResult["claimPath"] = "slow-clone";
      const forceFetch = opts?.forceFetch === true;
      const skipReuse = opts?.skipReuse === true;
      const skipWarm = opts?.skipWarm === true;
      const excluded = new Set(opts?.excludeSessionIds ?? []);
      const tabKey = opts?.tabId && !skipReuse ? `${opts.tabId}\n${url}` : undefined;

      const claimLocked = async (): Promise<Omit<ClaimSessionResult, "claimPath">> => {
        const inFlightWarming = deps.waitForWarmSession?.(url);
        if (inFlightWarming) await inFlightWarming;

        // Warming can change the pool pointer during the await.
        const repoAfterWarm = deps.repoStore.get(url) ?? repo;

        // Only this tab's own draft: another tab's draft may still be on screen (docs/285 req 13).
        const draftId = tabKey ? draftByTab.get(tabKey) : undefined;
        const draft = draftId ? deps.sessionManager.get(draftId) : undefined;
        const reusable = draft &&
          draft.warm &&
          draft.remoteUrl === url &&
          draft.id !== repoAfterWarm.warmSessionId &&
          !excluded.has(draft.id) &&
          // Clearing a network override would leave its old container topology running.
          (deps.egressAllowlistStore?.getSessionOverride(draft.id) ?? null) === null &&
          // SSH grants picked in Session settings before the first message must not carry over either.
          !(draft.sshHosts?.length) &&
          draft.workspaceDir &&
          existsSync(path.join(draft.workspaceDir, ".git"))
          ? draft
          : undefined;
        if (reusable?.workspaceDir) {
          claimPath = "reuse";
          const fetchDurationMs = await refreshClaimedSession(url, reusable.workspaceDir, forceFetch);
          return { sessionId: reusable.id, workspaceDir: reusable.workspaceDir, fetchDurationMs };
        }

        const currentRepo = deps.repoStore.get(url);
        if (!skipWarm && currentRepo?.warmSessionId && !excluded.has(currentRepo.warmSessionId)) {
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

        const warmingPromise = skipWarm ? undefined : deps.waitForWarmSession?.(url);
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

        try {
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
          // Before the pull: a declared LFS host's secret is looked up by this record.
          deps.sessionManager.setRemoteUrl(appSessionId, url);
          // Materialize after checkout, which writes LFS pointer stubs.
          await materializeLfsWithWarning(workspaceDir, url, (message) =>
            deps.sseBroadcast("error", { message }),
          );
          handWorkspaceBackToWorker(workspaceDir);

          deps.sessionManager.setBranch(appSessionId, branchPrefix);
          deps.sessionManager.setWarm(appSessionId, true);

          rewarmPool(url);

          return { sessionId: appSessionId, workspaceDir, fetchDurationMs };
        } catch (err) {
          // The row is visible from creation; left behind, it opens as a session with no workspace.
          deps.sessionManager.delete(appSessionId);
          deps.sseBroadcast("session_list", { sessions: deps.sessionManager.list() });
          throw err;
        }
      };

      const result = await serializeClaim(url, async () => {
        const claimed = await claimLocked();
        // Inside the lock, so a second claim from the same tab sees it.
        if (tabKey) {
          draftByTab.delete(tabKey);
          draftByTab.set(tabKey, claimed.sessionId);
          if (draftByTab.size > MAX_TAB_DRAFTS) draftByTab.delete(draftByTab.keys().next().value!);
        }
        return claimed;
      });

      // The session exists and no caller holds its id yet, so nothing from here on may reject.
      try {
        // Exclude clone-time file writes from the docs viewer's session-modified group.
        deps.sessionManager.markStarted(result.sessionId);
      } catch (err) {
        console.error(`[claim-session] Could not stamp ${result.sessionId} as started:`, getErrorMessage(err));
      }

      // Inspect Docker: a warm-pool pointer can survive a missed container die event.
      const standbyRunning = await deps.containerManager
        ?.isTrackedContainerRunning(result.sessionId)
        .catch(() => undefined);
      const standby = standbyRunning === true ? "ready"
        : standbyRunning === false ? "missing"
        : "unknown";
      const preview = deps.previewState?.(result.sessionId) ?? "unknown";
      console.log(
        `[timing] claim-session for ${url} path=${claimPath} standby=${standby} preview=${preview} ` +
          `total=${Date.now() - claimStart}ms fetch=${result.fetchDurationMs}ms`,
      );

      return { ...result, claimPath };
    },
  };
}
