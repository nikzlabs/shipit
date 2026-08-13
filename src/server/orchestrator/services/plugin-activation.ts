/**
 * docs/262 — activate every plugin repository a session declares.
 *
 * The lifecycle half of `plugin-generations.ts`: reads the session's
 * `plugins:` block, brings each tracked repository to its declared version,
 * and remembers the outcome so the browser snapshot can report it without
 * re-running anything (a GET must never trigger activation).
 *
 * Called from the same two moments compose configuration is applied
 * (`service-manager-setup.ts`): session activation, and a `shipit.yaml` edit.
 * Both are fire-and-forget — a slow fetch must not delay a session opening
 * (req 13: the session opens regardless), and the tab reports the interim
 * state.
 */

import { activateGeneration, readActiveGeneration, type GenerationRecord } from "../plugin-generations.js";
import { resolveShipitConfig } from "../../shared/shipit-config.js";
import { sessionStateDirForWorkspace } from "../session-state-dir.js";
import type { DeclaredPluginRepo } from "../../shared/plugin-repos.js";

/** What the tab shows for one tracked repository, beyond what's on disk. */
export interface PluginRepoActivationState {
  /** Activation is running right now — the tab shows a working state. */
  activating: boolean;
  /** The live generation, if any. */
  generation?: GenerationRecord;
  /**
   * Why the last attempt failed. Present WITH `generation` when a refresh
   * failed but the prior version is still active (req 15's degraded state).
   */
  error?: string;
  /** Advisory: a moved tag the durable pin overrode (req 8). */
  warning?: string;
  /** Selected exports the declared version lacks, when that is why it failed (phase 2). */
  missingSelectors?: string[];
}

/**
 * Per-session activation state, keyed `sessionId::repoName`. In-memory on
 * purpose: the durable facts (which commit is live) are on disk in the
 * generation record, and this only carries the transient "what happened on the
 * last attempt" the UI needs.
 */
const activationState = new Map<string, PluginRepoActivationState>();

/**
 * Monotonic per session. Bumped by {@link clearActivationState}, so a
 * fire-and-forget activation that finishes AFTER its session was disposed
 * cannot repopulate the map (review finding 8) — its epoch is stale and every
 * write is dropped.
 */
const epochs = new Map<string, number>();

/**
 * How many triggers are currently activating each repository, keyed
 * `sessionId::epoch::repoName`.
 *
 * `activating` has to mean "another result is coming", not "the trigger I
 * happened to watch has finished": two overlapping triggers would otherwise
 * have the first one clear the flag while the second is still queued, and a
 * browser polling in that window would stop early and show a stale card. Only
 * the last trigger out clears it.
 *
 * **The epoch is part of the key** (third-review finding): with a bare
 * `sessionId::repoName`, a stale activation from a disposed round could
 * decrement a *newer* round's counter after the session was recreated,
 * letting that round's first trigger clear `activating` while its second was
 * still queued. Keying by epoch makes a dead round's decrement land on its
 * own dead key, where nothing reads it.
 */
const inFlight = new Map<string, number>();

const stateKey = (sessionId: string, repoName: string): string => `${sessionId}::${repoName}`;
const flightKey = (sessionId: string, epoch: number, repoName: string): string =>
  `${sessionId}::${epoch}::${repoName}`;

export function getActivationState(sessionId: string, repoName: string): PluginRepoActivationState | undefined {
  return activationState.get(stateKey(sessionId, repoName));
}

export function clearActivationState(sessionId: string): void {
  epochs.set(sessionId, (epochs.get(sessionId) ?? 0) + 1);
  for (const key of [...activationState.keys()]) {
    if (key.startsWith(`${sessionId}::`)) activationState.delete(key);
  }
  for (const key of [...inFlight.keys()]) {
    if (key.startsWith(`${sessionId}::`)) inFlight.delete(key);
  }
}

/** Notified when a session's activation round settles, so the UI can refetch. */
export type ActivationSettledHook = (sessionId: string) => void;

export interface PluginActivationDeps {
  /** Bare cache directory for a plugin repository's clone URL. */
  getBareCacheDir: (repoUrl: string) => string;
  /** Orchestrator-wide durable pin store (req 8 — project-scoped, not per session). */
  pinStorePath: string;
  /** Create/refresh the bare cache. Orchestrator-side, so fetch credentials never leave it (req 19). */
  ensureCache: (cacheDir: string, repoUrl: string) => Promise<void>;
  /**
   * Called once per session when every repository in this round has settled.
   * Activation is fire-and-forget, so without a push the browser can only
   * poll — and a poll that gives up leaves the card stuck (review finding).
   */
  onSettled?: ActivationSettledHook;
  /**
   * Run the selected plugins' `install` against a STAGED generation, before
   * anything is published (plan §1b). Injected all the way from
   * `bootstrap-managers`, because the implementation needs Docker — install
   * runs in a container of its own, and neither this module nor
   * `plugin-generations.ts` executes plugin-authored code (req 19).
   *
   * Omitted where there is no Docker (local mode, tests): the step is skipped
   * and activation is exactly what it was before.
   */
  runInstall?: PluginInstallHook;
}

/** The install hook's shape, taken from the generation engine that calls it. */
export type PluginInstallHook = NonNullable<Parameters<typeof activateGeneration>[1]["runInstall"]>;

/**
 * Activate every tracked repository the session declares. `self` entries are
 * skipped: they run the live working tree and have no generation (req 27).
 *
 * Never throws — each repository fails independently (req 14).
 */
export async function activateDeclaredPlugins(
  sessionId: string,
  workspaceDir: string,
  deps: PluginActivationDeps,
  consumerKey?: string,
): Promise<void> {
  let repos: DeclaredPluginRepo[];
  let selectedByRepo: Map<string, string[]>;
  let stateDir: string;
  try {
    const config = resolveShipitConfig(workspaceDir);
    // Still settle: a declaration emptied of repos must reach the container, or
    // links for repos that are no longer declared stay addressable until the
    // container is recreated (review finding).
    if (!config.plugins.declared) {
      settle(sessionId, deps);
      return;
    }
    repos = config.plugins.repos.filter((r) => r.source.kind === "github");
    // Phase-2 input: which exports this consumer actually selected from each
    // repository. A selected name the fetched manifest lacks invalidates that
    // repository's generation (plan §1a).
    selectedByRepo = new Map();
    for (const use of config.plugins.uses) {
      const key = use.from.toLowerCase();
      selectedByRepo.set(key, [...(selectedByRepo.get(key) ?? []), use.plugin]);
    }
    stateDir = sessionStateDirForWorkspace(workspaceDir);
  } catch {
    // A malformed document is already reported by the config warning path and
    // by the snapshot route; there is nothing to activate from it.
    return;
  }
  if (repos.length === 0) {
    settle(sessionId, deps);
    return;
  }

  const epoch = epochs.get(sessionId) ?? 0;
  const isCancelled = (): boolean => (epochs.get(sessionId) ?? 0) !== epoch;
  /** Drop any write whose session was disposed (or re-activated) meanwhile. */
  const setState = (repoName: string, state: PluginRepoActivationState): void => {
    if (isCancelled()) return;
    activationState.set(stateKey(sessionId, repoName), state);
  };

  await Promise.all(
    repos.map(async (repo) => {
      const key = flightKey(sessionId, epoch, repo.name);
      inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
      const existing = readActiveGeneration(stateDir, repo.name) ?? undefined;
      setState(repo.name, { activating: true, ...(existing ? { generation: existing } : {}) });

      const repoUrl = cloneUrl(repo);
      let outcome: Awaited<ReturnType<typeof activateGeneration>>;
      try {
        outcome = await activateGeneration(repo, {
          stateDir,
          bareCacheDir: deps.getBareCacheDir(repoUrl),
          repoUrl,
          // A project with no remote is identified by its session: two sessions
          // of an unremoted project are separate projects for pinning purposes.
          consumerKey: consumerKey ?? `session:${sessionId}`,
          pinStorePath: deps.pinStorePath,
          selectedExports: selectedByRepo.get(repo.name.toLowerCase()) ?? [],
          ensureCache: deps.ensureCache,
          isCancelled,
          ...(deps.runInstall ? { runInstall: deps.runInstall } : {}),
        });
      } catch (err) {
        // `activateGeneration` is documented never to throw, but the counter
        // must not strand `activating: true` forever if that ever changes.
        outcome = { status: "failed", reason: err instanceof Error ? err.message : String(err) };
      }

      // Another trigger is still queued for this repository, so the round is
      // not over: leave `activating` set and let the last one out report.
      const remaining = (inFlight.get(key) ?? 1) - 1;
      if (remaining > 0) {
        inFlight.set(key, remaining);
        return;
      }
      inFlight.delete(key);

      if (outcome.status === "failed") {
        setState(repo.name, {
          activating: false,
          error: outcome.reason,
          ...(outcome.previous ? { generation: outcome.previous } : {}),
          ...(outcome.warning ? { warning: outcome.warning } : {}),
          ...(outcome.missingSelectors?.length ? { missingSelectors: outcome.missingSelectors } : {}),
        });
        console.warn(`[plugins:${sessionId}] ${repo.name}: ${outcome.reason}`);
        return;
      }
      setState(repo.name, {
        activating: false,
        generation: outcome.generation,
        // req 8 — a moved tag that the durable pin overrode is advisory, and
        // it must reach the user on the SUCCESS path too.
        ...(outcome.warning ? { warning: outcome.warning } : {}),
      });
    }),
  );

  // Tell the browser the round settled, so it refetches instead of polling
  // until its budget runs out.
  if (!isCancelled()) deps.onSettled?.(sessionId);
}

/**
 * Settle a round that had nothing to activate. Still notifies: the container's
 * prepare step is also what REMOVES links for repos the declaration no longer
 * names, so an emptied `plugins:` block must reach it or a dropped repository
 * stays addressable at `/plugins/<name>` until the container is recreated.
 */
function settle(sessionId: string, deps: PluginActivationDeps): void {
  deps.onSettled?.(sessionId);
}

/** The clone URL for a declared repo. GitHub-only in v1 (plan §1a). */
function cloneUrl(repo: DeclaredPluginRepo): string {
  if (repo.source.kind === "self") throw new Error("self repos have no clone URL");
  return `https://github.com/${repo.source.owner}/${repo.source.repo}.git`;
}
