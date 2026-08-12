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

const stateKey = (sessionId: string, repoName: string): string => `${sessionId}::${repoName}`;

export function getActivationState(sessionId: string, repoName: string): PluginRepoActivationState | undefined {
  return activationState.get(stateKey(sessionId, repoName));
}

export function clearActivationState(sessionId: string): void {
  epochs.set(sessionId, (epochs.get(sessionId) ?? 0) + 1);
  for (const key of [...activationState.keys()]) {
    if (key.startsWith(`${sessionId}::`)) activationState.delete(key);
  }
}

export interface PluginActivationDeps {
  /** Bare cache directory for a plugin repository's clone URL. */
  getBareCacheDir: (repoUrl: string) => string;
  /** Orchestrator-wide durable pin store (req 8 — project-scoped, not per session). */
  pinStorePath: string;
  /** Create/refresh the bare cache. Orchestrator-side, so fetch credentials never leave it (req 19). */
  ensureCache: (cacheDir: string, repoUrl: string) => Promise<void>;
}

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
    if (!config.plugins.declared) return;
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
  if (repos.length === 0) return;

  const epoch = epochs.get(sessionId) ?? 0;
  /** Drop any write whose session was disposed (or re-activated) meanwhile. */
  const setState = (repoName: string, state: PluginRepoActivationState): void => {
    if ((epochs.get(sessionId) ?? 0) !== epoch) return;
    activationState.set(stateKey(sessionId, repoName), state);
  };

  await Promise.all(
    repos.map(async (repo) => {
      const existing = readActiveGeneration(stateDir, repo.name) ?? undefined;
      setState(repo.name, { activating: true, ...(existing ? { generation: existing } : {}) });

      const repoUrl = cloneUrl(repo);
      const outcome = await activateGeneration(repo, {
        stateDir,
        bareCacheDir: deps.getBareCacheDir(repoUrl),
        repoUrl,
        // A project with no remote is identified by its session: two sessions
        // of an unremoted project are separate projects for pinning purposes.
        consumerKey: consumerKey ?? `session:${sessionId}`,
        pinStorePath: deps.pinStorePath,
        selectedExports: selectedByRepo.get(repo.name.toLowerCase()) ?? [],
        ensureCache: deps.ensureCache,
      });

      if (outcome.status === "failed") {
        setState(repo.name, {
          activating: false,
          error: outcome.reason,
          ...(outcome.previous ? { generation: outcome.previous } : {}),
          ...(outcome.warning ? { warning: outcome.warning } : {}),
        });
        console.warn(`[plugins:${sessionId}] ${repo.name}: ${outcome.reason}`);
        return;
      }
      setState(repo.name, { activating: false, generation: outcome.generation });
    }),
  );
}

/** The clone URL for a declared repo. GitHub-only in v1 (plan §1a). */
function cloneUrl(repo: DeclaredPluginRepo): string {
  if (repo.source.kind === "self") throw new Error("self repos have no clone URL");
  return `https://github.com/${repo.source.owner}/${repo.source.repo}.git`;
}
