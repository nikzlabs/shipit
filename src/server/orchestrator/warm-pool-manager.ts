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
import { resolveShipitConfig } from "../shared/shipit-config.js";
import { workerInstall, workerGet } from "./worker-http.js";

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
  warmSessionForRepo: (repoUrl: string) => Promise<void>;
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

  const warmSessionForRepo = async (repoUrl: string): Promise<void> => {
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

        // Normalize the cache's remote.origin.url to the plain URL. The
        // global credential helper provides the token at fetch time; embedding
        // it in the URL is redundant and leaks the token into error messages
        // and config files. Also overwrites any token a previous code path
        // baked into this cache's origin URL.
        if (githubAuthManager.authenticated) {
          await cacheGit.setRemoteUrl(repoUrl);
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
        //
        // No caller-side opt-out: every code path that warms a repo also
        // wants a standby + pre-install, and a "warm but no standby" state
        // is exactly what made docs/148 silently regress (every prod
        // restart left every repo without pre-install). The local-mode /
        // test-mode paths surface that intent the right way — by passing
        // `containerManager: null` here.
        if (oomBreaker?.isTripped(appSessionId)) {
          console.warn(`[warm] Skipping standby for ${appSessionId}: OOM circuit breaker tripped`);
        }
        const standbyAllowed = containerManager && !oomBreaker?.isTripped(appSessionId);
        if (standbyAllowed && containerManager) {
          const realCount = containerManager.size - containerManager.standbyCount;
          const maxIdle = credentialStore.getMaxIdleContainers();
          if (realCount < maxIdle) {
            // `buildConfigForWorkspace` reads shipit.yaml so the standby
            // container is provisioned with the user's declared agent
            // resources (memory/cpu/pids) and docker-access capability.
            // Without this entry point, plain `buildConfig` falls back to
            // the manager's defaults (1.5 GB / 0.5 CPU / 256 pids) — so a
            // repo declaring `agent.memory: 3072` would get a 1.5 GB
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
              // Pre-run agent.install so the user doesn't wait for it on activation.
              // The standby's workspace is bind-mounted from `workspaceDir`, so the
              // success marker (`.shipit/.install-done`) persists for the future
              // runner: on activation, `runner.runInstall()` hits the worker, sees
              // the marker, and short-circuits with `{ skipped: true }`. If the
              // user activates *during* pre-install, the worker's /install endpoint
              // joins the in-flight run (no longer 409s) and the orchestrator-side
              // SSE listener resolves on the same `install_done`/`install_error`.
              await runPreInstall(workspaceDir, sc.workerUrl, appSessionId);
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

/**
 * Pre-run `agent.install` on a freshly-booted standby worker so the user
 * doesn't pay install latency on activation. Reads shipit.yaml from the
 * warm workspace, fires the install on the standby's worker, and polls
 * `/install/status` until it settles.
 *
 * Best-effort: any failure here just means the on-activation install runs
 * as it does today — we log and return rather than break the warm flow.
 *
 * Exported for the focused unit test in `warm-pool-preinstall.test.ts`,
 * which exercises the helper against a real Fastify worker stub instead of
 * standing up the full warm-pool + Docker path.
 */
export async function runPreInstall(workspaceDir: string, workerUrl: string, sessionId: string): Promise<void> {
  let commands: string[];
  try {
    commands = resolveShipitConfig(workspaceDir).agent.install;
  } catch (err) {
    console.warn(`[warm:install:${sessionId}] Skipping pre-install — could not parse shipit.yaml: ${getErrorMessage(err)}`);
    return;
  }
  if (commands.length === 0) return;

  try {
    const res = await workerInstall(workerUrl, commands) as { skipped?: boolean; started?: boolean };
    if (res.skipped) {
      console.log(`[warm:install:${sessionId}] Pre-install skipped (marker present)`);
      return;
    }
    if (!res.started) return;

    // Worker returned 202-ish "started" — poll /install/status until done. The
    // worker writes the `.shipit/.install-done` marker on success itself; we
    // just need to know when it's no longer running so we can log the outcome.
    // Pre-install is bounded by a hard ceiling so a wedged `npm install` can't
    // leak a polling loop for the entire orchestrator lifetime.
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
        return;
      }
    }
    console.warn(`[warm:install:${sessionId}] Pre-install still running after ${MAX_WAIT_MS}ms — leaving worker to finish; on-activation runInstall will join it via /install`);
  } catch (err) {
    console.warn(`[warm:install:${sessionId}] Pre-install request failed: ${getErrorMessage(err)}`);
  }
}
