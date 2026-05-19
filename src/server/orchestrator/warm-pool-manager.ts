import fs from "node:fs/promises";
import simpleGit from "simple-git";
import type { RepoStore } from "./repo-store.js";
import type { SessionManager } from "./sessions.js";
import type { RepoGit } from "./repo-git.js";
import type { GitHubAuthManager } from "./github-auth.js";
import type { CredentialStore } from "./credential-store.js";
import type { SessionContainerManager } from "./session-container.js";
import type { SessionOomCircuitBreaker } from "./oom-circuit-breaker.js";
import { generateBranchPrefix, fetchAndResolveDefaultBranch } from "./git-utils.js";
import { getErrorMessage } from "./validation.js";

// ---- Warm session pool ----

/** Dependencies for warm session pool. */
export interface WarmPoolDeps {
  repoStore: RepoStore;
  sessionManager: SessionManager;
  createRepoGit: (dir: string) => RepoGit;
  githubAuthManager: GitHubAuthManager;
  credentialStore: CredentialStore;
  containerManager: SessionContainerManager | null;
  credentialsDir: string;
  getBareCacheDir: (repoUrl: string) => string;
  getDepCacheDir: (repoUrl: string) => string;
  createSessionDir: (title: string) => Promise<{ appSessionId: string; sessionDir: string; workspaceDir: string }>;
  sseBroadcast: (event: string, data: unknown) => void;
  /**
   * Shared OOM circuit breaker. Standby creation consults it before
   * spawning a container so the breaker stays the single authority over
   * "should we make a container right now?" — defense-in-depth, since
   * the standby ID is freshly allocated and would not normally carry
   * OOM history. If we ever re-warm a session that previously tripped,
   * this check stops the standby from being created at the
   * under-provisioned limit just to OOM again.
   */
  oomBreaker?: SessionOomCircuitBreaker;
}

/**
 * Create the warm session pool functions: `warmSessionForRepo` and
 * `waitForWarmSession`.
 */
export function createWarmPool(
  poolDeps: WarmPoolDeps,
): {
  warmSessionForRepo: (repoUrl: string, opts?: { withStandby?: boolean }) => Promise<void>;
  waitForWarmSession: (repoUrl: string) => Promise<void> | undefined;
} {
  const {
    repoStore, sessionManager, createRepoGit,
    githubAuthManager, credentialStore, containerManager,
    credentialsDir, getBareCacheDir, getDepCacheDir, createSessionDir, sseBroadcast,
    oomBreaker,
  } = poolDeps;

  const warmingInProgress = new Set<string>();
  const warmingPromises = new Map<string, Promise<void>>();

  const warmSessionForRepo = async (repoUrl: string, opts?: { withStandby?: boolean }): Promise<void> => {
    const repo = repoStore.get(repoUrl);
    if (repo?.status !== "ready") return;
    // Don't warm if already has a warm session or is currently warming
    if (warmingInProgress.has(repoUrl)) return;
    if (repo.warmSessionId) {
      const existing = sessionManager.get(repo.warmSessionId);
      if (existing) return;
    }
    warmingInProgress.add(repoUrl);

    // The promise is stored so the claim endpoint can await it instead
    // of falling to the expensive slow path.
    const p = (async () => {
      try {
        const cacheDir = getBareCacheDir(repoUrl);
        // eslint-disable-next-line no-restricted-syntax -- stat existence-check idiom
        const cacheExists = await fs.stat(cacheDir).then(() => true, () => false);
        if (!cacheExists) return;

        const branchPrefix = generateBranchPrefix();
        const created = await createSessionDir("Warm session");
        const { appSessionId, sessionDir, workspaceDir } = created;

        // Mark as warm before doing git work
        sessionManager.setWarm(appSessionId, true);
        sessionManager.setRemoteUrl(appSessionId, repoUrl);

        const cacheGit = createRepoGit(cacheDir);

        // Refresh remote URL with current token (the bare cache may have a stale
        // token embedded from clone time).
        if (githubAuthManager.authenticated) {
          const freshUrl = githubAuthManager.getAuthenticatedCloneUrl(repoUrl);
          await cacheGit.setRemoteUrl(freshUrl);
        }

        // Fetch latest refs in the bare cache (with 60s TTL). Non-fatal —
        // the real-remote fetch in the workspace clone below (W2) is what
        // actually determines the branch point now — but a cache that
        // can't fetch is surfaced so a stale repo doesn't silently serve
        // warm sessions frozen at an old commit.
        try {
          await cacheGit.fetchCache();
        } catch (fetchErr) {
          console.warn("[warm] Cache fetch failed (non-fatal):", String(fetchErr));
          sseBroadcast("error", {
            message: `Repository cache for ${repoUrl} could not be refreshed — warm sessions may be based on stale code: ${getErrorMessage(fetchErr)}`,
          });
        }

        // Remove the workspace subdir (clone needs it absent)
        await fs.rm(workspaceDir, { recursive: true, force: true });

        // Clone from bare cache into workspace subdir (hardlinked, fast)
        await cacheGit.cloneFromCache(workspaceDir, repoUrl);

        // Configure credentials BEFORE the real-remote fetch below — the
        // workspace clone's origin is the plain (unauthenticated) URL, so
        // a private-repo fetch needs the credential helper in place.
        if (githubAuthManager.authenticated) {
          githubAuthManager.configureGitCredentials(workspaceDir);
        }

        // W2: `cloneFromCache` only snapshotted the (possibly hundreds-of-
        // commits-stale) bare cache. Fetch the real remote in the workspace
        // clone so the warm branch is cut from the genuine latest commit —
        // otherwise the standby container's memory limit is derived from a
        // frozen `shipit.yaml`. Shared helper with the claim path so they
        // can't drift.
        const { resetTarget, fetched, authError } = await fetchAndResolveDefaultBranch(
          workspaceDir,
          (err) => githubAuthManager.markTokenInvalid(`warm-pool fetch failed for ${repoUrl}: ${err.message}`),
        );
        if (!fetched && !authError) {
          // The workspace-clone fetch failed — the warm branch is being cut
          // from the (possibly stale) `git clone --local` snapshot. Surface
          // it: a silent no-op fetch here is the W2 root cause.
          // Auth errors get their own dedicated `github_status` SSE
          // broadcast (via `markTokenInvalid`), so don't double up here.
          console.warn(`[warm] Workspace fetch failed for ${appSessionId} — branching from the bare-cache snapshot, which may be stale`);
          sseBroadcast("error", {
            message: `Warm session for ${repoUrl} may be based on stale code — could not fetch the latest commits.`,
          });
        }
        const branchArgs = ["checkout", "-b", branchPrefix];
        if (resetTarget) branchArgs.push(resetTarget);
        await simpleGit(workspaceDir).raw(branchArgs);

        sessionManager.setBranch(appSessionId, branchPrefix);

        // Store the warm session ID on the repo.
        // Container + runner are created on-demand when the user activates
        // the session (WS connect → activateSession → getOrCreate).
        repoStore.setWarmSessionId(repoUrl, appSessionId);

        // Boot a standby container so the next activation is instant.
        // Defense-in-depth — the breaker is the single authority on
        // "should we make a container right now?". `appSessionId` is
        // brand new so this normally passes; the check matters only if
        // a future re-warm path reuses a tripped session ID. We skip
        // standby creation only (not the rest of the warm flow), so the
        // session is still warmed and ready for on-demand activation —
        // which goes through `createContainerForRunner`, which also
        // consults the breaker.
        const standbyAllowed = opts?.withStandby && containerManager && !oomBreaker?.isTripped(appSessionId);
        if (opts?.withStandby && oomBreaker?.isTripped(appSessionId)) {
          console.warn(`[warm] Skipping standby for ${appSessionId}: OOM circuit breaker tripped`);
        }
        if (standbyAllowed && containerManager) {
          const realCount = containerManager.size - containerManager.standbyCount;
          const maxIdle = credentialStore.getMaxIdleContainers();
          if (realCount < maxIdle) {
            // `buildConfigForWorkspace` reads shipit.yaml so the standby
            // container is provisioned with the user's declared agent
            // resources (memory/cpu/pids) and docker-access capability.
            // Without this entry point, plain `buildConfig` falls back to
            // the manager's defaults (1 GB / 0.5 CPU / 256 pids) — so a
            // repo declaring `agent.memory: 3072` would get a 1 GB
            // container from the warm pool, OOMing on first turn when
            // npm install + claude both run inside the under-provisioned
            // cgroup.
            const config = containerManager.buildConfigForWorkspace({
              sessionId: appSessionId,
              sessionDir,
              workspaceDir,
              credentialsDir,
              depCacheDir: getDepCacheDir(repoUrl),
            });
            // eslint-disable-next-line no-restricted-syntax -- intentional fire-and-forget in sync warming callback
            containerManager.createStandby(config).then(async (sc) => {
              console.log(`[warm] Standby container ready for ${appSessionId} at ${sc.workerUrl}`);
              // Pre-run install so the user doesn't wait for it on activation.
              // Preview endpoints live on the preview container, not the session container.
              // Warm container ready — compose stack startup handled by ServiceManager
            }).catch((err: unknown) => {
              console.error(`[warm] Standby container failed for ${appSessionId}:`, getErrorMessage(err));
            });
          }
        }

        // Broadcast so client knows the repo is ready for instant sessions
        sseBroadcast("repo_warm_ready", { url: repoUrl, sessionId: appSessionId });

        console.log(`[warm] Warm session ${appSessionId} ready for ${repoUrl}`);
      } catch (err) {
        console.error(`[warm] Failed to warm session for ${repoUrl}:`, getErrorMessage(err));
      } finally {
        warmingInProgress.delete(repoUrl);
        warmingPromises.delete(repoUrl);
      }
    })();
    warmingPromises.set(repoUrl, p);
    return p;
  };

  const waitForWarmSession = (repoUrl: string): Promise<void> | undefined => {
    return warmingPromises.get(repoUrl);
  };

  return { warmSessionForRepo, waitForWarmSession };
}
