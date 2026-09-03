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

// ---- Warm session pool ----

/** Dependencies for warm session pool. */
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
  /**
   * docs/284 — the latest memory snapshot, so standby creation can be skipped
   * when ShipIt is already at its memory budget. Optional: without it the pool
   * behaves as it did when the guard was a container count with no reading
   * available, i.e. it creates the standby.
   */
  getMemoryStats?: () => DockerMemoryStats | null;
}

/** A warm session that needs a standby container built for it. */
export interface EnsureStandbyOptions {
  sessionId: string;
  /** The session's parent dir — the container's `/session-state` mount. */
  sessionDir: string;
  /** The clone, mounted at `/workspace`. */
  workspaceDir: string;
  repoUrl: string;
  /**
   * Re-checked immediately before the container is created, after the preflight
   * awaits. The teardown epoch covers a DESTROY that lands mid-preflight; this
   * covers the other order — a claim taking the session and activating it, so
   * that a container already exists and is nobody's standby. Creating one then
   * would label a live session's container `standby`, which is what the idle
   * enforcer deletes first (review finding). Absent = always wanted.
   */
  stillWanted?: () => boolean;
}

/**
 * Create the warm session pool functions: `warmSessionForRepo`,
 * `waitForWarmSession` and `ensureStandbyForWarmSession`.
 */
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
    oomBreaker, getMemoryStats,
  } = poolDeps;

  const warmingInProgress = new Set<string>();
  const warmingPromises = new Map<string, Promise<void>>();

  /**
   * Boot a standby container for an already-warmed session and pre-run
   * `agent.install` on it.
   *
   * Called from two places, deliberately: the warm flow below (a session that
   * has just been cloned) and the periodic warm-tier sweep (a session whose
   * standby has since died — planning#501). Both want exactly this, and a
   * second copy of it is how docs/148 regressed: the standby and the
   * pre-install are one unit, and a caller that gets one without the other
   * looks warm and behaves cold.
   *
   * Best-effort throughout: every failure leaves the session warm and
   * claimable, paying the cold cost the caller was trying to avoid.
   */
  const ensureStandbyForWarmSession = async (opts: EnsureStandbyOptions): Promise<void> => {
    const { sessionId, sessionDir, workspaceDir, repoUrl } = opts;
    if (!containerManager) return;
    // Whole body guarded: every caller discards this promise, so a throw
    // anywhere here — including the preflight below — would be an unhandled
    // rejection rather than a session that merely stays cold (review finding).
    try {
      // Defense-in-depth — the breaker is the single authority on "should we
      // make a container right now?". A session that has OOM'd before must not
      // get a speculative container just to OOM again.
      if (oomBreaker?.isTripped(sessionId)) {
        console.warn(`[warm] Skipping standby for ${sessionId}: OOM circuit breaker tripped`);
        return;
      }
      // docs/284 — a standby is speculative work, so it is the first thing to
      // skip when the machine is tight.
      if (isUnderEvictionPressure(getMemoryStats?.() ?? null)) return;

      // Snapshot the teardown counter BEFORE the preflight awaits below, which
      // is what its docstring asks for: a destroy that lands while we prepare
      // (a claim activating this session, the idle enforcer dropping the
      // standby under pressure) is then newer than our intent, and `create`
      // abandons rather than resurrecting a container nobody wants. Without it
      // the sweep can rebuild a standby for a session a user has just claimed —
      // and label a live session's container `standby`, which is what tier 0
      // deletes first (review finding).
      const intentEpoch = containerManager.teardownEpoch(sessionId);

      // `buildConfigForWorkspace` reads shipit.yaml so the standby gets the
      // repo's declared agent resources (memory/cpu/pids) and docker-access
      // capability; plain `buildConfig` would hand a repo declaring
      // `agent.memory: 3072` a 1.5 GB container that OOMs on its first turn.
      // docs/183 / docs/197 — build it WITH the overlay specs (or, for pnpm, the
      // shared store): this is the one container-creation path that does not go
      // through `createContainerForRunner`, so without them a warm hit silently
      // runs plain. Both helpers are inert when their flag is off.
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
      // docs/178 — trust gate. Pre-running `agent.install` fires the repo's setup
      // shell before the user has ever opened the session, with zero
      // interaction. Skip it for an untrusted remote; the standby itself runs no
      // repo code, so booting it is safe. Once trusted, the on-activation
      // `runner.runInstall()` runs it (the marker is simply absent).
      if (!repoStore.isTrusted(repoUrl)) {
        console.log(`[warm:install:${sessionId}] Skipping pre-install for untrusted remote ${repoUrl} — awaiting first-clone trust`);
        return;
      }
      // docs/246 — the marker is written to the session's STATE dir, not the
      // clone, so it persists for the future runner: on activation
      // `runner.runInstall()` sees it and short-circuits. A user activating
      // mid-install joins the in-flight run via the worker's /install endpoint.
      await runPreInstall(workspaceDir, sc.workerUrl, sessionId);
    } catch (err) {
      console.error(`[warm] Standby container failed for ${sessionId}:`, getErrorMessage(err));
    }
  };

  const warmSessionForRepo = async (repoUrl: string): Promise<void> => {
    // Every call site below `void`-discards the returned promise, so a
    // synchronous throw from these `better-sqlite3` reads (which fire from
    // setTimeout(0)-driven sweeps, claim-session re-warming, send-message
    // hooks, etc.) would surface as an unhandled rejection and fail
    // vitest's UNHANDLED ERRORS gate. Production never closes the DB
    // mid-request, but the shape of "background task vs. shutting-down DB"
    // is real in tests — keep the function safe-by-construction.
    let repo;
    try {
      repo = repoStore.get(repoUrl);
      if (repo?.status !== "ready") return;
      // Don't warm if already has a warm session or is currently warming
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
          { resolveRemoteCredential: gitRemoteCredentialResolver(githubAuthManager) },
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
        await safeSimpleGit(workspaceDir).raw(branchArgs);

        // Realign the local default branch (`main`) with `origin/main` so a
        // later "review the PR" comparison against `main` doesn't pick up
        // commits that are already on main but ahead of the stale bare-cache
        // snapshot this clone was cut from (docs/194).
        await syncLocalDefaultBranchToOrigin(workspaceDir);
        // docs/231 — pull Git LFS content. Must come after the `checkout -b`
        // above, which re-writes pointer stubs into the worktree. Warming
        // happens off the user's critical path, so this is the cheapest place to
        // absorb the transfer for asset-heavy repos.
        //
        // planning#412 — this used to add "and before the chown below (the pull
        // writes files as root)". That reason DIED with docs/266-orchestrator-git-trust-boundary E1 and the
        // sentence outlived it. `cloneFromCache` hands the tree to the session
        // uid before returning (`repo-git.ts:320`), so the `checkout -b` above
        // — which goes through `safeSimpleGit` — already drops and writes
        // worker-owned stubs, and the pull drops to the same identity. Nothing
        // here is written as root any more.
        //
        // The stale half of that sentence was read as current fact by two
        // sessions and nearly produced a reordering of all four LFS call sites,
        // so it is worth being explicit: the ordering constraint that remains is
        // "after the checkout", not "before the chown".
        await materializeLfsWithWarning(workspaceDir, repoUrl, (message) =>
          sseBroadcast("error", { message }),
        );
        // docs/150 §7 addendum (planning#147): hand the workspace back — both
        // halves, because `checkout -b <resetTarget>` re-materializes the
        // WORKTREE and not just `.git`.
        //
        // planning#412 — what this repairs is the CLONE, not the ops listed
        // above. `cloneFromCache`'s `git clone --local` is a bare
        // `safeSimpleGit()` naming no directory to stat, so it alone runs as
        // root and lands `root:root` (`git-hooks-guard.ts`, "blind to a tree it
        // CREATES"); `cloneFromCache` already hands that tree over before it
        // returns (`repo-git.ts`), and every op here — fetch, `checkout -b`,
        // ref realignment, the LFS pull — then goes through
        // `safeSimpleGit(workspaceDir)` / `gitSpawnOverridesForTree` and drops
        // to this session's identity, so each writes worker-owned files. This
        // call is what reconciles `.git` with `resolveGitDirOwner` — the uid
        // that will next RUN git in it — and hands the worktree to the identity
        // the container runs as. It is a no-op wherever no identity resolves
        // (local mode, dev, tests), which is also the only place the ops above
        // still write as root.
        handWorkspaceBackToWorker(workspaceDir);

        sessionManager.setBranch(appSessionId, branchPrefix);

        // Store the warm session ID on the repo.
        // Container + runner are created on-demand when the user activates
        // the session (WS connect → activateSession → getOrCreate).
        repoStore.setWarmSessionId(repoUrl, appSessionId);

        // Boot a standby container (+ pre-install) so the next activation is
        // instant. Fire-and-forget: warming must never sit on a claim's
        // critical path (docs/144). No caller-side opt-out — every path that
        // warms a repo wants this, and a "warm but no standby" state is exactly
        // what made docs/148 silently regress. The local-mode / test-mode paths
        // express the opt-out the right way, by passing `containerManager: null`.
        void ensureStandbyForWarmSession({
          sessionId: appSessionId, sessionDir, workspaceDir, repoUrl,
        });

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

  return { warmSessionForRepo, waitForWarmSession, ensureStandbyForWarmSession };
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
    // The worker returns `{ started: true }` / `{ skipped: true }` fast and
    // streams completion via SSE; we poll /install/status below. The timeout
    // only bounds the POST itself, kept generous so a slow daemon doesn't trip
    // it.
    const res = await workerInstall(workerUrl, commands, { timeoutMs: 180_000 }) as
      { skipped?: boolean; started?: boolean; ok?: boolean };
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
