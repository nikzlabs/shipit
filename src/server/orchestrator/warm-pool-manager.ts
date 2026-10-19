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
import { newOverlayClaimToken, releaseOverlayBaseClaims } from "./overlay-base-claims.js";
import { isRecentlyUsedRepo } from "./warm-recency.js";
import type { DockerMemoryStats } from "../shared/types.js";
import type { ServiceManager } from "./service-manager.js";

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
  /** Cheap: whether a pre-start would do anything, so a periodic repair asks before the worker. */
  previewWanted?: (target: WarmPreviewTarget) => boolean;
  /** `ClaimSessionService.refreshWarm`: moves the clone under the claim lock (req 13). */
  refreshWarmClone?: (repoUrl: string, sessionId: string) => Promise<{ headChanged: boolean } | null>;
  /** The warm session's pre-started stack, whose install gate a refresh's reinstall holds. */
  previewGate?: (sessionId: string) => Pick<ServiceManager, "setInstallRunning"> | undefined;
}

export interface WarmPreviewTarget {
  sessionId: string;
  workspaceDir: string;
  repoUrl: string;
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
  repairWarmPreview: (opts: WarmPreviewTarget) => Promise<void>;
  refreshWarmSession: (opts: WarmPreviewTarget) => Promise<void>;
} {
  const {
    repoStore, sessionManager, createRepoGit,
    githubAuthManager, containerManager,
    credentialsDir, getBareCacheDir, getDepCacheDir, createSessionDir, sseBroadcast,
    oomBreaker, getMemoryStats, preStartPreview, previewWanted, refreshWarmClone, previewGate,
  } = poolDeps;

  const warmingInProgress = new Set<string>();
  const warmingPromises = new Map<string, Promise<void>>();
  // A refresh moved HEAD but its install request never reached the worker; the next pass retries it.
  const installPending = new Set<string>();

  // The one route to a warm preview: the warm flow and the periodic repair both come through here.
  const installThenPreStart = async (opts: WarmPreviewTarget & { workerUrl: string }): Promise<void> => {
    const { sessionId, workspaceDir, repoUrl, workerUrl } = opts;
    // Install and preview commands execute repository code and require trust.
    if (!repoStore.isTrusted(repoUrl)) {
      console.log(`[warm:install:${sessionId}] Skipping pre-install for untrusted remote ${repoUrl} — awaiting first-clone trust`);
      return;
    }
    const install = await runPreInstall(workspaceDir, workerUrl, sessionId);
    // Awaiting alone is insufficient: failures and timeouts also resolve.
    if (!install.settled) {
      console.log(
        `[warm:${sessionId}] Skipping preview pre-start — the pre-install did not settle;`
        + " the preview starts on activation, behind the runner's own install gate",
      );
      return;
    }
    await preStartPreview?.({ sessionId, workspaceDir, repoUrl });
  };

  const repairWarmPreview = async (opts: WarmPreviewTarget): Promise<void> => {
    const { sessionId, repoUrl } = opts;
    const sc = containerManager?.get(sessionId);
    if (!preStartPreview || sc?.status !== "running") return;
    if (!repoStore.isTrusted(repoUrl)) return;
    if (previewWanted && !previewWanted(opts)) return;
    const status = await workerGet(sc.workerUrl, "/install/status").catch(() => null) as
      | { running?: boolean; lastResult?: { ok: boolean } | null }
      | null;
    // A running install is joined by a later pass; a failed one is not retried unattended.
    if (!status || status.running || status.lastResult?.ok === false) return;
    await installThenPreStart({ ...opts, workerUrl: sc.workerUrl });
  };

  // Keep a recent repo's warm clone on the default branch, so a claim seldom has to move it (req 13).
  const refreshWarmSession = async (opts: WarmPreviewTarget): Promise<void> => {
    const { sessionId, workspaceDir, repoUrl } = opts;
    const sc = containerManager?.get(sessionId);
    if (!refreshWarmClone || sc?.status !== "running") return;
    // The install that may follow runs repository code.
    if (!repoStore.isTrusted(repoUrl)) return;
    if (!isRecentlyUsedRepo(repoStore.get(repoUrl)?.lastUsedAt)) return;
    const status = await workerGet(sc.workerUrl, "/install/status").catch(() => null) as
      | { running?: boolean }
      | null;
    if (!status || status.running) return;

    const refreshed = await refreshWarmClone(repoUrl, sessionId);
    if (!refreshed) {
      installPending.delete(sessionId);
      return;
    }
    if (!refreshed.headChanged && !installPending.has(sessionId)) return;
    if (refreshed.headChanged) {
      console.log(`[warm:${sessionId}] Warm clone moved to the latest default branch of ${repoUrl}`);
    }
    // A real install holds the pre-started services, as a mid-session reinstall does, so none keeps
    // serving the old dependencies. A claim that adopts the stack meanwhile finds the gate held, and
    // this release still opens it. A marker skip holds nothing: the dev server's watcher suffices (req 5).
    const gate = previewGate?.(sessionId);
    let held = false;
    const install = await runPreInstall(workspaceDir, sc.workerUrl, sessionId, {
      onStarted: () => { held = gate?.setInstallRunning(true) ?? false; },
    });
    if (held && gate) {
      if (install.timedOut) {
        // Released on the install's real end: latched as failed now, it stays failed for a claim
        // that adopts the stack, because adoption did not open this hold and will not close it.
        const containerAlive = (): boolean => {
          const now = containerManager?.get(sessionId);
          return now?.status === "running" && now.workerUrl === sc.workerUrl;
        };
        void (async () => {
          gate.setInstallRunning(false, { failed: !(await waitForInstallEnd(sc.workerUrl, containerAlive)) });
        })();
      } else {
        gate.setInstallRunning(false, { failed: !install.settled });
      }
    }
    if (!install.settled && !install.ran) installPending.add(sessionId);
    else installPending.delete(sessionId);
  };

  const ensureStandbyForWarmSession = async (opts: EnsureStandbyOptions): Promise<void> => {
    const { sessionId, sessionDir, workspaceDir, repoUrl } = opts;
    if (!containerManager) return;
    const claimToken = newOverlayClaimToken();
    try {
      if (oomBreaker?.isTripped(sessionId)) {
        console.warn(`[warm] Skipping standby for ${sessionId}: OOM circuit breaker tripped`);
        return;
      }
      if (isUnderEvictionPressure(getMemoryStats?.() ?? null)) {
        console.log(`[warm] Skipping standby for ${sessionId}: memory is at the eviction threshold`);
        return;
      }

      // A destroy during preflight must invalidate this creation attempt.
      const intentEpoch = containerManager.teardownEpoch(sessionId);

      // This path bypasses createContainerForRunner; include its overlays and resource config.
      const overlaySpecs = await containerManager.prepareOverlaySpecs({
        sessionId,
        workspaceDir,
        session: { remoteUrl: repoUrl, kind: undefined },
        claimToken,
      });
      const pnpmStoreDir = containerManager.preparePnpmStore({
        sessionId,
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
      await installThenPreStart({ sessionId, workspaceDir, repoUrl, workerUrl: sc.workerUrl });
    } catch (err) {
      console.error(`[warm] Standby container failed for ${sessionId}:`, getErrorMessage(err));
    } finally {
      // The base-generation claim covers select→mount; Docker is the liveness evidence afterwards.
      releaseOverlayBaseClaims(claimToken);
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

  return {
    warmSessionForRepo, waitForWarmSession, ensureStandbyForWarmSession, repairWarmPreview, refreshWarmSession,
  };
}

export interface PreInstallOutcome {
  settled: boolean;
  /** The worker ran (or joined) a real install rather than skipping on its marker. */
  ran?: boolean;
  /** The poll gave up while the worker was still installing. */
  timedOut?: boolean;
}

const INSTALL_END_POLL_MS = 10_000;

/**
 * Whether the worker's running install ended well; false once its container is gone. A status
 * request that fails is only lost contact, and ending on it would latch the gate as failed.
 */
export async function waitForInstallEnd(workerUrl: string, containerAlive: () => boolean): Promise<boolean> {
  for (;;) {
    await new Promise((r) => setTimeout(r, INSTALL_END_POLL_MS));
    if (!containerAlive()) return false;
    const status = await workerGet(workerUrl, "/install/status").catch(() => null) as
      | { running?: boolean; lastResult?: { ok: boolean } | null }
      | null;
    if (status && !status.running) return status.lastResult?.ok !== false;
  }
}

export async function runPreInstall(
  workspaceDir: string, workerUrl: string, sessionId: string,
  opts: { onStarted?: () => void } = {},
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
    opts.onStarted?.();

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
        return { settled: ok, ran: true };
      }
    }
    console.warn(`[warm:install:${sessionId}] Pre-install still running after ${MAX_WAIT_MS}ms — leaving worker to finish; on-activation runInstall will join it via /install`);
    return { settled: false, ran: true, timedOut: true };
  } catch (err) {
    console.warn(`[warm:install:${sessionId}] Pre-install request failed: ${getErrorMessage(err)}`);
    return { settled: false };
  }
}
