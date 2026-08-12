/**
 * docs/262 — activate every plugin repository a session declares.
 *
 * The lifecycle half of `plugin-generations.ts`: reads the session's
 * `plugins:` block, brings each tracked repository to its declared version,
 * and remembers the outcome so the browser snapshot can report it without
 * re-running anything (a GET must never trigger an install).
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
}

/**
 * Per-session activation state, keyed `sessionId::repoName`. In-memory on
 * purpose: the durable facts (which commit is live, which pin was resolved)
 * are on disk in the generation record, and this only carries the transient
 * "what happened on the last attempt" the UI needs.
 */
const activationState = new Map<string, PluginRepoActivationState>();

const stateKey = (sessionId: string, repoName: string): string => `${sessionId}::${repoName}`;

export function getActivationState(sessionId: string, repoName: string): PluginRepoActivationState | undefined {
  return activationState.get(stateKey(sessionId, repoName));
}

export function clearActivationState(sessionId: string): void {
  for (const key of [...activationState.keys()]) {
    if (key.startsWith(`${sessionId}::`)) activationState.delete(key);
  }
}

export interface PluginActivationDeps {
  /** Bare cache directory for a plugin repository's clone URL. */
  getBareCacheDir: (repoUrl: string) => string;
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
): Promise<void> {
  let repos: DeclaredPluginRepo[];
  let stateDir: string;
  try {
    const config = resolveShipitConfig(workspaceDir);
    if (!config.plugins.declared) return;
    repos = config.plugins.repos.filter((r) => r.source.kind === "github");
    stateDir = sessionStateDirForWorkspace(workspaceDir);
  } catch {
    // A malformed document is already reported by the config warning path and
    // by the snapshot route; there is nothing to activate from it.
    return;
  }
  if (repos.length === 0) return;

  await Promise.all(
    repos.map(async (repo) => {
      const key = stateKey(sessionId, repo.name);
      const existing = readActiveGeneration(stateDir, repo.name) ?? undefined;
      activationState.set(key, { activating: true, ...(existing ? { generation: existing } : {}) });

      const repoUrl = cloneUrl(repo);
      const outcome = await activateGeneration(repo, {
        stateDir,
        bareCacheDir: deps.getBareCacheDir(repoUrl),
        repoUrl,
        ensureCache: deps.ensureCache,
      });

      if (outcome.status === "failed") {
        activationState.set(key, {
          activating: false,
          error: outcome.reason,
          ...(outcome.previous ? { generation: outcome.previous } : {}),
        });
        console.warn(`[plugins:${sessionId}] ${repo.name}: ${outcome.reason}`);
        return;
      }
      activationState.set(key, { activating: false, generation: outcome.generation });
    }),
  );
}

/** The clone URL for a declared repo. GitHub-only in v1 (plan §1a). */
function cloneUrl(repo: DeclaredPluginRepo): string {
  if (repo.source.kind === "self") throw new Error("self repos have no clone URL");
  return `https://github.com/${repo.source.owner}/${repo.source.repo}.git`;
}
