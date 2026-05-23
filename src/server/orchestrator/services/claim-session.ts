/**
 * Session-claim service.
 *
 * Encapsulates the warm-pool-aware "give me a workspace for this repo" flow
 * shared by the home-screen claim route (`POST /api/repos/:url/claim-session`)
 * and the agent-spawned-sessions path (`spawnChildSession`). Both surfaces
 * end up wanting the same thing — a freshly-cloned workspace branched off
 * the real `origin/main` of the repo — and historically the home-screen had
 * the warm-pool integration while spawn cut its branch off the parent's
 * HEAD from a possibly-stale bare cache. This service is what makes the two
 * paths produce identical workspaces.
 *
 * The per-repo `claimChains` serialization lives inside the factory closure,
 * so a single service instance must be shared across all callers (route +
 * spawn) for the serialization to actually guard concurrent claims.
 */

import { existsSync, unlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import simpleGit from "simple-git";
import type { SessionManager } from "../sessions.js";
import type { GitManager } from "../../shared/git.js";
import type { RepoGit } from "../repo-git.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { RepoStore } from "../repo-store.js";
import type { SessionContainerManager } from "../session-container.js";
import { ServiceError } from "./types.js";
import {
  generateBranchPrefix,
  fetchAndResolveDefaultBranch,
  isWorkspaceCloneInSyncWithCache,
} from "../git-utils.js";
import { resolveAgentDockerLimits } from "../session-container.js";
import { ensureBareCache } from "../repo-git.js";
import { getErrorMessage } from "../../shared/utils.js";

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
  warmSessionForRepo?: (repoUrl: string, opts?: { withStandby?: boolean }) => Promise<void>;
  waitForWarmSession?: (repoUrl: string) => Promise<void> | undefined;
  shouldSkipClaimFetch?: (repoUrl: string) => boolean;
  containerManager?: SessionContainerManager;
}

export interface ClaimSessionResult {
  sessionId: string;
  workspaceDir: string;
  fetchDurationMs: number;
  claimPath: "reuse" | "warm" | "waiting" | "slow-clone";
}

export interface ClaimSessionOptions {
  /**
   * Polled at strategic points so the caller can short-circuit if e.g. the
   * HTTP request was aborted. When it returns `true` between paths, the
   * service throws a `ClaimAbortedError` instead of proceeding.
   */
  isCancelled?: () => boolean;
}

export class ClaimAbortedError extends Error {
  constructor() {
    super("Claim aborted by caller");
    this.name = "ClaimAbortedError";
  }
}

export interface ClaimSessionService {
  /**
   * Claim a workspace for `url`. Reuses an ungraduated warm session when one
   * exists, claims a pre-warmed session, waits for in-flight warming, or
   * falls through to a synchronous clone. The returned workspace is always
   * branched off the real remote's default branch (origin/main / origin/master
   * / origin/HEAD).
   *
   * Throws:
   *  - `ServiceError(404)` when the repo is not registered.
   *  - `ServiceError(400)` when the repo is still cloning.
   *  - `ClaimAbortedError` when `opts.isCancelled` returns true.
   */
  claim(url: string, opts?: ClaimSessionOptions): Promise<ClaimSessionResult>;
}

export function createClaimSessionService(deps: ClaimSessionDeps): ClaimSessionService {
  // Per-repo promise chain: serializes claim requests for the same repo so
  // git operations (fetch, clone) never run concurrently on the same bare
  // cache. Shared by every caller of this service instance (the HTTP route
  // and the spawn flow), which is why this lives in the factory closure
  // rather than module scope.
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

  /**
   * After a claim-time clone refresh moved HEAD, the standby container may
   * have booted with resource limits derived from a now-stale `shipit.yaml`
   * — the irreducible warm→claim time gap (warm provisions from commit C1,
   * claim refreshes to C2). Container memory is immutable at runtime, so the
   * only fix is to destroy the standby: the runner factory's fresh-create
   * path rebuilds it with the current limits on first attach.
   */
  async function reprovisionStandbyIfLimitsChanged(
    sessionId: string,
    workspaceDir: string,
  ): Promise<void> {
    const cm = deps.containerManager;
    if (!cm) return;
    const container = cm.get(sessionId);
    if (!container?.bootedLimits) return;
    let fresh;
    try {
      fresh = resolveAgentDockerLimits(workspaceDir);
    } catch (err) {
      console.warn(`[claim-session] Cannot re-derive limits for ${sessionId}: ${getErrorMessage(err)}`);
      return;
    }
    const booted = container.bootedLimits;
    if (
      fresh.memoryLimit === booted.memoryLimit &&
      fresh.cpuQuota === booted.cpuQuota &&
      fresh.pidsLimit === booted.pidsLimit
    ) {
      return;
    }
    console.warn(
      `[claim-session] Standby container for ${sessionId} booted with stale resource limits ` +
        `(mem ${booted.memoryLimit} → ${fresh.memoryLimit}, cpu ${booted.cpuQuota} → ${fresh.cpuQuota}, ` +
        `pids ${booted.pidsLimit} → ${fresh.pidsLimit}) after a HEAD change — destroying so it ` +
        `rebuilds with the current shipit.yaml on first attach.`,
    );
    await cm.destroy(sessionId);
  }

  /**
   * Surface a workspace-clone fetch that silently no-op'd during a claim —
   * the W2 root cause. When `fetched` is false the clone was *not* refreshed
   * against the real remote, so the claimed session may be on stale code.
   */
  function warnIfStaleClaimFetch(fetched: boolean, url: string): void {
    if (fetched) return;
    console.warn(`[claim-session] Workspace fetch failed for ${url} — using the existing clone, which may be stale`);
    deps.sseBroadcast("error", {
      message: `Claimed session for ${url} may be based on stale code — could not fetch the latest commits.`,
    });
  }

  /**
   * Fetch latest origin refs and hard-reset a warm session clone to the
   * current remote HEAD. Safe because warm sessions have zero user changes.
   * Non-fatal — if fetch or reset fails, the session still works with older
   * code.
   *
   * Always (re-)configures the workspace's credential helper before fetching.
   * Reused sessions can be hours/days old and may have either no local
   * credential helper or one with a now-expired token baked in.
   */
  async function refreshCloneToLatestMain(
    sessionDir: string,
    onAuthError?: (err: Error) => void,
  ): Promise<{ headChanged: boolean; fetched: boolean; fetchDurationMs: number }> {
    const sessionGit = deps.createGitManager(sessionDir);
    const headBefore = await sessionGit.getHeadHash();
    if (deps.githubAuthManager.authenticated) {
      deps.githubAuthManager.configureGitCredentials(sessionDir);
    }
    const { resetTarget, fetched, fetchDurationMs } = await fetchAndResolveDefaultBranch(sessionDir, onAuthError);
    if (resetTarget) {
      await sessionGit.rollback(resetTarget);
    }
    const headAfter = await sessionGit.getHeadHash();
    const headChanged = headBefore !== headAfter;
    if (headChanged) {
      try { unlinkSync(path.join(sessionDir, ".shipit", ".install-done")); } catch { /* marker may not exist */ }
    }
    return { headChanged, fetched, fetchDurationMs };
  }

  /**
   * Shared tail of the reuse / warm / waiting sub-paths: refresh the claimed
   * session's clone to latest main, surface a stale-fetch warning, and
   * re-provision the standby if a HEAD move invalidated its booted limits.
   * Returns the fetch duration (for timing). Deliberately does NOT re-warm
   * the pool — that's the caller's concern.
   */
  async function refreshClaimedSession(
    url: string,
    sessionId: string,
    workspaceDir: string,
  ): Promise<number> {
    // docs/145: skip the synchronous fetch when the bare cache was
    // pre-fetched in the background recently AND this clone's `origin/HEAD`
    // already matches the cache's current HEAD.
    if (
      deps.shouldSkipClaimFetch?.(url) &&
      (await isWorkspaceCloneInSyncWithCache(workspaceDir, deps.getSharedRepoDir(url)))
    ) {
      return 0;
    }
    try {
      const r = await refreshCloneToLatestMain(
        workspaceDir,
        (err) => deps.githubAuthManager.markTokenInvalid(`claim-session refresh failed for ${url}: ${err.message}`),
      );
      warnIfStaleClaimFetch(r.fetched, url);
      if (r.headChanged) {
        await reprovisionStandbyIfLimitsChanged(sessionId, workspaceDir);
      }
      return r.fetchDurationMs;
    } catch (err) {
      console.error(`[claim-session] Failed to refresh clone to latest main:`, getErrorMessage(err));
      return 0;
    }
  }

  /**
   * Re-warm the pool for the *next* session — fire-and-forget so this
   * claim's response isn't blocked on prep work for a future user.
   */
  function rewarmPool(url: string): void {
    if (deps.warmSessionForRepo) void deps.warmSessionForRepo(url, { withStandby: true });
  }

  return {
    async claim(url, opts): Promise<ClaimSessionResult> {
      const repo = deps.repoStore.get(url);
      if (!repo) throw new ServiceError(404, "Repository not found");
      if (repo.status !== "ready") throw new ServiceError(400, "Repository is still cloning");

      const claimStart = Date.now();
      let claimPath: ClaimSessionResult["claimPath"] = "slow-clone";

      const result = await serializeClaim(url, async () => {
        const inFlightWarming = deps.waitForWarmSession?.(url);
        if (inFlightWarming) await inFlightWarming;

        // Reuse path: check for previously-claimed warm session.
        const reusable = deps.sessionManager.findUngraduatedWarm(url, repo.warmSessionId ?? undefined);
        if (reusable?.workspaceDir && existsSync(path.join(reusable.workspaceDir, ".git"))) {
          claimPath = "reuse";
          const fetchDurationMs = await refreshClaimedSession(url, reusable.id, reusable.workspaceDir);
          return { sessionId: reusable.id, workspaceDir: reusable.workspaceDir, fetchDurationMs };
        }

        // Warm path: claim the pre-warmed session.
        const currentRepo = deps.repoStore.get(url);
        if (currentRepo?.warmSessionId) {
          const warmSession = deps.sessionManager.get(currentRepo.warmSessionId);
          if (warmSession?.workspaceDir) {
            claimPath = "warm";
            const sessionId = currentRepo.warmSessionId;
            deps.repoStore.setWarmSessionId(url, undefined);
            const fetchDurationMs = await refreshClaimedSession(url, sessionId, warmSession.workspaceDir);
            rewarmPool(url);
            return { sessionId, workspaceDir: warmSession.workspaceDir, fetchDurationMs };
          }
        }

        // Waiting path: wait for in-progress warming.
        const warmingPromise = deps.waitForWarmSession?.(url);
        if (warmingPromise) {
          await warmingPromise;
          const freshRepo = deps.repoStore.get(url);
          if (freshRepo?.warmSessionId) {
            const warmSession = deps.sessionManager.get(freshRepo.warmSessionId);
            if (warmSession?.workspaceDir) {
              claimPath = "waiting";
              const sessionId = freshRepo.warmSessionId;
              deps.repoStore.setWarmSessionId(url, undefined);
              const fetchDurationMs = await refreshClaimedSession(url, sessionId, warmSession.workspaceDir);
              rewarmPool(url);
              return { sessionId, workspaceDir: warmSession.workspaceDir, fetchDurationMs };
            }
          }
        }

        // Slow path: clone from bare cache synchronously.
        claimPath = "slow-clone";
        if (opts?.isCancelled?.()) throw new ClaimAbortedError();
        const cacheDir = deps.getSharedRepoDir(url);
        const branchPrefix = generateBranchPrefix();
        const created = await deps.createSessionDirFull("Warm session");
        const { appSessionId, workspaceDir } = created;

        await rm(workspaceDir, { recursive: true, force: true });

        // Self-heal a missing or corrupt bare cache.
        const { git: cacheGit } = await ensureBareCache(cacheDir, url, deps.createRepoGit);

        // Normalize the cache's remote.origin.url to the plain URL.
        if (deps.githubAuthManager.authenticated) {
          await cacheGit.setRemoteUrl(url);
        }

        try {
          await cacheGit.fetchCache();
        } catch (err) {
          // Non-fatal — `fetchAndResolveDefaultBranch` below fetches the real
          // remote directly in the workspace clone, so a stale bare cache no
          // longer freezes the slow path.
          console.error(`[claim-session] Fetch cache failed for ${url}:`, getErrorMessage(err));
          deps.sseBroadcast("error", {
            message: `Repository cache for ${url} could not be refreshed: ${getErrorMessage(err)}`,
          });
        }

        await cacheGit.cloneFromCache(workspaceDir, url);

        // Configure credentials BEFORE fetching the real remote.
        if (deps.githubAuthManager.authenticated) {
          deps.githubAuthManager.configureGitCredentials(workspaceDir);
        }

        const skipFetch = deps.shouldSkipClaimFetch?.(url) ?? false;
        const { resetTarget, fetched, fetchDurationMs, authError } = await fetchAndResolveDefaultBranch(
          workspaceDir,
          (err) => deps.githubAuthManager.markTokenInvalid(`claim-session fetch failed for ${url}: ${err.message}`),
          { skipFetch },
        );
        if (!skipFetch && !fetched && !authError) {
          console.warn(`[claim-session] Workspace fetch failed for ${url} — branching from the bare-cache snapshot, which may be stale`);
          deps.sseBroadcast("error", {
            message: `Claimed session for ${url} may be based on stale code — could not fetch the latest commits.`,
          });
        }
        const branchArgs = ["checkout", "-b", branchPrefix];
        if (resetTarget) branchArgs.push(resetTarget);
        await simpleGit(workspaceDir).raw(branchArgs);

        deps.sessionManager.setRemoteUrl(appSessionId, url);
        deps.sessionManager.setBranch(appSessionId, branchPrefix);
        deps.sessionManager.setWarm(appSessionId, true);

        rewarmPool(url);

        return { sessionId: appSessionId, workspaceDir, fetchDurationMs };
      });

      // Reset created_at to "now" for the claimed session. Warm-pool warming
      // inserts the session row before the workspace is cloned, so without
      // this reset every file in the freshly-cloned workspace would have
      // mtime > createdAt and the docs viewer's "modified in this session"
      // group would incorrectly list everything in the repo.
      deps.sessionManager.markStarted(result.sessionId);

      console.log(
        `[timing] claim-session for ${url} path=${claimPath} ` +
          `total=${Date.now() - claimStart}ms fetch=${result.fetchDurationMs}ms`,
      );

      return { ...result, claimPath };
    },
  };
}
