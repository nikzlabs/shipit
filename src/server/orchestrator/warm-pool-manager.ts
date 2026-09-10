import fs from "node:fs/promises";
import { safeSimpleGit } from "../shared/git-hooks-guard.js";
import type { RepoStore } from "./repo-store.js";
import type { SessionManager } from "./sessions.js";
import type { RepoGit } from "./repo-git.js";
import type { GitHubAuthManager } from "./github-auth.js";
import type { SessionContainerManager } from "./session-container.js";
import type { SessionOomCircuitBreaker } from "./oom-circuit-breaker.js";
import { generateBranchPrefix, fetchAndResolveDefaultBranch, syncLocalDefaultBranchToOrigin } from "./git-utils.js";
import { gitRemoteCredentialResolver } from "./services/github.js";
import { handWorkspaceBackToWorker } from "./session-worker-uid.js";
import { materializeLfsWithWarning } from "./git-lfs.js";
import { getErrorMessage } from "./validation.js";
import { resolveShipitConfig } from "../shared/shipit-config.js";
import { workerInstall, workerGet } from "./worker-http.js";
import { isUnderEvictionPressure } from "./memory-pressure.js";
import type { DockerMemoryStats } from "../shared/types.js";

export interface WarmPoolDeps {
  repoStore: RepoStore;
  sessionManager: SessionManager;
  createRepoGit: (dir: string) => RepoGit;
  githubAuthManager: GitHubAuthManager;
  containerManager: SessionContainerManager | null;
  credentialsDir: string;
  getBareCacheDir: (repoUrl: string) => string;
  getDepCacheDir: (repoUrl: string) => string;
  createSessionDir: (title: string) => Promise<{ appSessionId: string; sessionDir: string; workspaceDir: string }>;
  sseBroadcast: (event: string, data: unknown) => void;
  oomBreaker?: SessionOomCircuitBreaker;
  getMemoryStats?: () => DockerMemoryStats | null;
  preStartPreview?: (opts: {
    sessionId: string;
    workspaceDir: string;
    repoUrl: string;
  }) => Promise<void>;
}

export interface EnsureStandbyOptions {
  sessionId: string;
  sessionDir: string;
  workspaceDir: string;
  repoUrl: string;
  /** Recheck ownership after preflight so a claim cannot be relabeled as standby. */
  stillWanted?: () => boolean;
}

export function createWarmPool(
  poolDeps: WarmPoolDeps,
): {
  warmSessionForRepo: (repoUrl: string) => Promise<void>;
  waitForWarmSession: (repoUrl: string) => Promise<void> | undefined;
  ensureStandbyForWarmSession: (opts: EnsureStandbyOptions) => Promise<void>;
} {
  const {
    repoStore, sessionManager, createRepoGit,
    githubAuthManager, containerManager,
    credentialsDir, getBareCacheDir, getDepCacheDir, createSessionDir, sseBroadcast,
    oomBreaker, getMemoryStats, preStartPreview,
  } = poolDeps;

  const warmingInProgress = new Set<string>();
  const warmingPromises = new Map<string, Promise<void>>();

  const ensureStandbyForWarmSession = async (opts: EnsureStandbyOptions): Promise<void> => {
    const { sessionId, sessionDir, workspaceDir, repoUrl } = opts;
    if (!containerManager) return;
    try {
      if (oomBreaker?.isTripped(sessionId)) {
        console.warn(`[warm] Skipping standby for ${sessionId}: OOM circuit breaker tripped`);
        return;
      }
      if (isUnderEvictionPressure(getMemoryStats?.() ?? null)) return;

      // A destroy during preflight must invalidate this creation attempt.
      const intentEpoch = containerManager.teardownEpoch(sessionId);

      // This path bypasses createContainerForRunner; include its overlays and resource config.
      const overlaySpecs = await containerManager.prepareOverlaySpecs({
        sessionId,
        workspaceDir,
        session: { remoteUrl: repoUrl, kind: undefined },
      });
      const pnpmStoreDir = containerManager.preparePnpmStore({
        workspaceDir,
        session: { remoteUrl: repoUrl, kind: undefined },
      });
      const config = containerManager.buildConfigForWorkspace({
        sessionId,
        sessionDir,
        workspaceDir,
        credentialsDir,
        depCacheDir: getDepCacheDir(repoUrl),
        pnpmStoreDir,
        overlaySpecs,
      });
      if (opts.stillWanted?.() === false) {
        console.log(`[warm] Standby for ${sessionId} abandoned — the session is no longer warm`);
        return;
      }
      const sc = await containerManager.createStandby(config, { intentEpoch });
      console.log(`[warm] Standby container ready for ${sessionId} at ${sc.workerUrl}`);
      // Install and preview commands execute repository code and require trust.
      if (!repoStore.isTrusted(repoUrl)) {
        console.log(`[warm:install:${sessionId}] Skipping pre-install for untrusted remote ${repoUrl} — awaiting first-clone trust`);
        return;
      }
      const install = await runPreInstall(workspaceDir, sc.workerUrl, sessionId);
      // Awaiting alone is insufficient: failures and timeouts also resolve.
      if (!install.settled) {
        console.log(
          `[warm:${sessionId}] Skipping preview pre-start — the pre-install did not settle;`
          + " the preview starts on activation, behind the runner's own install gate",
        );
        return;
      }
      await preStartPreview?.({ sessionId, workspaceDir, repoUrl });
    } catch (err) {
      console.error(`[warm] Standby container failed for ${sessionId}:`, getErrorMessage(err));
    }
  };

  const warmSessionForRepo = async (repoUrl: string): Promise<void> => {
    // Background warming can race DB shutdown.
    let repo;
    try {
      repo = repoStore.get(repoUrl);
      if (repo?.status !== "ready") return;
      if (warmingInProgress.has(repoUrl)) return;
      if (repo.warmSessionId) {
        const existing = sessionManager.get(repo.warmSessionId);
        if (existing) return;
      }
    } catch (err) {
      console.error(`[warm] Preflight DB read failed for ${repoUrl}:`, getErrorMessage(err));
      return;
    }
    warmingInProgress.add(repoUrl);

    const p = (async () => {
      try {
        const cacheDir = getBareCacheDir(repoUrl);
        // eslint-disable-next-line no-restricted-syntax -- stat existence-check idiom
        const cacheExists = await fs.stat(cacheDir).then(() => true, () => false);
        if (!cacheExists) return;

        const branchPrefix = generateBranchPrefix();
        const created = await createSessionDir("Warm session");
        const { appSessionId, sessionDir, workspaceDir } = created;

        sessionManager.setWarm(appSessionId, true);
        sessionManager.setRemoteUrl(appSessionId, repoUrl);

        const cacheGit = createRepoGit(cacheDir);

        // Credentials belong in the helper, not the persisted remote URL.
        if (githubAuthManager.authenticated) {
          await cacheGit.setRemoteUrl(repoUrl);
        }

        try {
          await cacheGit.fetchCache();
        } catch (fetchErr) {
          console.warn("[warm] Cache fetch failed (non-fatal):", String(fetchErr));
          sseBroadcast("error", {
            message: `Repository cache for ${repoUrl} could not be refreshed — warm sessions may be based on stale code: ${getErrorMessage(fetchErr)}`,
          });
        }

        await fs.rm(workspaceDir, { recursive: true, force: true });
        await cacheGit.cloneFromCache(workspaceDir, repoUrl);

        if (githubAuthManager.authenticated) {
          githubAuthManager.configureGitCredentials(workspaceDir);
        }

        // Fetch the real remote; the local cache snapshot may be stale.
        const { resetTarget, fetched, authError } = await fetchAndResolveDefaultBranch(
          workspaceDir,
          (err) => githubAuthManager.markTokenInvalid(`warm-pool fetch failed for ${repoUrl}: ${err.message}`),
          { resolveRemoteCredential: gitRemoteCredentialResolver(githubAuthManager) },
        );
        if (!fetched && !authError) {
          // Auth failures already emit their own status.
          console.warn(`[warm] Workspace fetch failed for ${appSessionId} — branching from the bare-cache snapshot, which may be stale`);
          sseBroadcast("error", {
            message: `Warm session for ${repoUrl} may be based on stale code — could not fetch the latest commits.`,
          });
        }
        const branchArgs = ["checkout", "-b", branchPrefix];
        if (resetTarget) branchArgs.push(resetTarget);
        await safeSimpleGit(workspaceDir).raw(branchArgs);

        await syncLocalDefaultBranchToOrigin(workspaceDir);
        // Checkout restores LFS pointer stubs; materialize after it.
        await materializeLfsWithWarning(workspaceDir, repoUrl, (message) =>
          sseBroadcast("error", { message }),
        );
        handWorkspaceBackToWorker(workspaceDir);

        sessionManager.setBranch(appSessionId, branchPrefix);
        repoStore.setWarmSessionId(repoUrl, appSessionId);

        // Claims may await cloning, but must not wait for standby/install/preview startup.
        void ensureStandbyForWarmSession({
          sessionId: appSessionId, sessionDir, workspaceDir, repoUrl,
        });

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

  return { warmSessionForRepo, waitForWarmSession, ensureStandbyForWarmSession };
}

export interface PreInstallOutcome {
  settled: boolean;
}

export async function runPreInstall(
  workspaceDir: string, workerUrl: string, sessionId: string,
): Promise<PreInstallOutcome> {
  let commands: string[];
  try {
    commands = resolveShipitConfig(workspaceDir).agent.install;
  } catch (err) {
    console.warn(`[warm:install:${sessionId}] Skipping pre-install — could not parse shipit.yaml: ${getErrorMessage(err)}`);
    return { settled: false };
  }
  if (commands.length === 0) return { settled: true };

  try {
    const res = await workerInstall(workerUrl, commands, { timeoutMs: 180_000 }) as
      { skipped?: boolean; started?: boolean; ok?: boolean };
    if (res.skipped) {
      console.log(`[warm:install:${sessionId}] Pre-install skipped (marker present)`);
      return { settled: true };
    }
    if (!res.started) return { settled: false };

    // Bound polling; a timeout leaves the worker installing for activation to join.
    const POLL_INTERVAL_MS = 2_000;
    const MAX_WAIT_MS = 15 * 60 * 1000;
    const start = Date.now();
    while (Date.now() - start < MAX_WAIT_MS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const status = await workerGet(workerUrl, "/install/status").catch(() => null) as
        | { running?: boolean; lastResult?: { ok: boolean; message?: string } | null }
        | null;
      if (!status) continue;
      if (!status.running) {
        const ok = status.lastResult?.ok !== false;
        console.log(`[warm:install:${sessionId}] Pre-install ${ok ? "complete" : "failed"}${status.lastResult?.message ? `: ${status.lastResult.message}` : ""}`);
        return { settled: ok };
      }
    }
    console.warn(`[warm:install:${sessionId}] Pre-install still running after ${MAX_WAIT_MS}ms — leaving worker to finish; on-activation runInstall will join it via /install`);
    return { settled: false };
  } catch (err) {
    console.warn(`[warm:install:${sessionId}] Pre-install request failed: ${getErrorMessage(err)}`);
    return { settled: false };
  }
}
