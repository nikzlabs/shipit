/**
 * Proactive bare-cache git pre-fetch (docs/145).
 *
 * The claim-session path used to pay a synchronous `git fetch` to GitHub on
 * every "New Session" — ~650ms and ~95% of claim latency, dominated by the
 * network round-trip even when nothing had changed. This module moves that
 * fetch *off* the critical path: it keeps each ready repo's **bare cache**
 * close to `origin/main` in the background, so the claim path can skip its
 * synchronous fetch and trust a recently-refreshed cache (see
 * `coveredRecently` and the claim handler's skip in `api-routes-session.ts`).
 *
 * Scope discipline (a guardrail from the plan): this pre-fetcher touches the
 * **bare cache only**. It never reaches into a session's live working clone —
 * a session is a normal feature branch that is expected to diverge from
 * `main` after its branch is cut, and fast-forwarding a live clone under the
 * agent is exactly the hazard we refuse to introduce. Keeping the bare cache
 * fresh is sufficient: new branches (warm-pool re-warms, slow-path clones)
 * are cut from it, so they start from a recent point.
 *
 * Two triggers, both off the request path:
 *   - **Periodic** — a low-frequency sweep of every `ready` repo.
 *   - **On change** — `prefetchRepo()` fires when we already know `main`
 *     moved (a merge surfaced by the PR poller). That's the moment the cache
 *     actually goes stale, so refreshing then keeps it fresh for almost no
 *     cost and avoids pointless polling when nothing changed.
 *
 * Overlapping triggers coalesce: `fetchCache`'s own 60s TTL guard makes a
 * redundant fetch a cheap no-op, and a per-repo in-flight set prevents two
 * `git fetch` children racing on the same bare cache.
 */

import type { RepoStore } from "./repo-store.js";
import type { RepoGit } from "./repo-git.js";
import type { GitHubAuthManager } from "./github-auth.js";
import { getErrorMessage } from "./validation.js";

/** How often the periodic sweep fetches every ready repo's bare cache. */
export const PREFETCH_INTERVAL_MS = 3 * 60_000;

/**
 * The claim path skips its synchronous fetch when the bare cache was fetched
 * within this window. Set to twice the sweep interval so a single missed
 * cycle (a slow fetch, a transient error) doesn't immediately force every
 * claim back onto the slow synchronous-fetch fallback.
 */
export const CLAIM_SKIP_WINDOW_MS = 2 * PREFETCH_INTERVAL_MS;

export interface RepoPrefetcherDeps {
  repoStore: RepoStore;
  getBareCacheDir: (repoUrl: string) => string;
  createRepoGit: (dir: string) => RepoGit;
  githubAuthManager: GitHubAuthManager;
}

export interface RepoPrefetcher {
  /** Start the periodic background sweep. Idempotent. */
  start(): void;
  /** Stop the periodic sweep (shutdown). Idempotent. */
  stop(): void;
  /**
   * Fire a background bare-cache fetch for one repo — the on-change trigger.
   * Fire-and-forget; coalesced via the in-flight set + `fetchCache` TTL.
   */
  prefetchRepo(repoUrl: string): void;
  /**
   * True when the repo's bare cache was successfully fetched within
   * `CLAIM_SKIP_WINDOW_MS`. The claim handler uses this to decide whether it
   * can skip its synchronous workspace fetch. Conservative: a repo that has
   * never been fetched, or whose last fetch is older than the window, returns
   * false so the claim falls back to a correct (if slower) synchronous fetch.
   */
  coveredRecently(repoUrl: string): boolean;
}

export function createRepoPrefetcher(deps: RepoPrefetcherDeps): RepoPrefetcher {
  const { repoStore, getBareCacheDir, createRepoGit, githubAuthManager } = deps;

  /** Repos with a `fetchCache` currently in flight — prevents racing fetches. */
  const inFlight = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const fetchOne = async (repoUrl: string): Promise<void> => {
    if (inFlight.has(repoUrl)) return;
    const repo = repoStore.get(repoUrl);
    if (repo?.status !== "ready") return;
    inFlight.add(repoUrl);
    try {
      const cacheGit = createRepoGit(getBareCacheDir(repoUrl));
      // Normalize the cache's origin to the plain URL so the global git
      // credential helper supplies the token at fetch time — mirrors the
      // warm-pool and slow-path. Embedding the token in the URL would leak
      // it into config and error messages.
      if (githubAuthManager.authenticated) {
        await cacheGit.setRemoteUrl(repoUrl);
      }
      // TTL-guarded — a fetch that ran <60s ago (e.g. a claim slow-path
      // just refreshed this cache) is a cheap no-op.
      await cacheGit.fetchCache();
    } catch (err) {
      // Best-effort: a transient fetch failure just means the claim path
      // falls back to its synchronous fetch until the next sweep succeeds.
      console.warn(`[prefetch] Bare-cache fetch failed for ${repoUrl} (non-fatal):`, getErrorMessage(err));
    } finally {
      inFlight.delete(repoUrl);
    }
  };

  const sweep = (): void => {
    for (const repo of repoStore.list()) {
      if (repo.status === "ready") void fetchOne(repo.url);
    }
  };

  return {
    start() {
      if (timer) return;
      timer = setInterval(sweep, PREFETCH_INTERVAL_MS);
      // Don't keep the event loop alive solely for the sweep.
      if (typeof timer.unref === "function") timer.unref();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    prefetchRepo(repoUrl: string) {
      void fetchOne(repoUrl);
    },
    coveredRecently(repoUrl: string): boolean {
      const repo = repoStore.get(repoUrl);
      if (repo?.status !== "ready") return false;
      const ageMs = createRepoGit(getBareCacheDir(repoUrl)).lastFetchAgeMs();
      return ageMs !== null && ageMs <= CLAIM_SKIP_WINDOW_MS;
    },
  };
}
