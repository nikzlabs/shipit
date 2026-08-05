/**
 * Bring a session's runner into existence (docs/131, reqs 8–10).
 *
 * This is the runner-materialization core that used to live only inside
 * `route-registry.ts`'s per-connection `activateSession` closure: reconcile the
 * runner's agent against the session row, restore an evicted checkout, and
 * `getOrCreate` the runner. `activateSession` still owns everything that is
 * genuinely per-connection (attach/detach, PR poller, notableFiles, the
 * reset-eligibility signal); it delegates the part that isn't to this function.
 *
 * The reason it moved: a session nobody has open — from an earlier boot, or one
 * that went idle — has no runner, and the HTTP dispatch route used to 404 at it
 * because only a WS connect could create one. The outer agent driving the inner
 * dogfood ShipIt (docs/131 req 8) has no WS, so "wake it the way a connect
 * would" had to become callable from a route. Extracting rather than
 * reimplementing keeps one activation path, so the archived guard and the
 * workspace-restore recovery can't drift between transports.
 *
 * Transport-specific reactions stay with the caller: this returns a
 * discriminated outcome instead of sending WS frames or throwing HTTP errors.
 */

import type { AgentId } from "../../shared/types.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { RepoGit } from "../repo-git.js";
import type { RepoStore } from "../repo-store.js";
import type { SessionRunnerInterface, SessionRunnerRegistry } from "../session-runner.js";
import type { SessionManager } from "../sessions.js";
import { getErrorMessage } from "../validation.js";
import { restoreSessionWorkspace } from "./session.js";

export interface MaterializeRunnerDeps {
  sessionManager: SessionManager;
  runnerRegistry: SessionRunnerRegistry;
  createRepoGit: (dir: string) => RepoGit;
  getBareCacheDir: (url: string) => string;
  githubAuthManager: GitHubAuthManager;
  repoStore: RepoStore;
}

export type MaterializeRunnerOutcome =
  /** A runner exists (found or created) and is ready to be dispatched at. */
  | { status: "ready"; runner: SessionRunnerInterface }
  /** Archived sessions receive nothing — never boot a container for one. */
  | { status: "archived" }
  /** No session row, or a session with no workspace (nothing to run against). */
  | { status: "no-workspace" }
  /** The checkout is gone and could not be re-cloned from the bare cache. */
  | { status: "restore-failed"; message: string };

/**
 * The one case that has to go to disk: the checkout is missing and has to be
 * re-cloned from the bare cache before a runner can be created.
 */
interface NeedsRestore {
  status: "needs-restore";
  workspaceDir: string;
  agentId: AgentId;
}

/**
 * Synchronous part of materialization — everything that doesn't touch the disk.
 *
 * Split out (rather than folded into the async function) because WS connect
 * calls this without awaiting and then sends more frames: making the common
 * path async would reorder `session_container_freshness` after the frames that
 * follow `void activateSession(...)`. A session with no remote resolves
 * entirely here, exactly as it did before this code moved out of
 * `activateSession`.
 */
export function materializeRunnerSync(
  deps: MaterializeRunnerDeps,
  sessionId: string,
  fallbackAgentId: AgentId,
): MaterializeRunnerOutcome | NeedsRestore {
  const session = deps.sessionManager.get(sessionId);

  // Never resurrect or re-track an archived session. A stray connection — or a
  // dispatch at a stale id — must not `getOrCreate` a runner (which boots a
  // container) or re-arm the PR poller: either would let an archived session
  // start receiving updates again. The legitimate restore path
  // (`unarchiveSession`) clears the flag before anyone activates.
  if (session?.archived || session?.userArchived) return { status: "archived" };

  const sessionAgentId = session?.agentId ?? fallbackAgentId;

  // An existing runner is authoritative — but its agent may be stale. A runner
  // is seeded with the global default at creation (warm pool, container
  // recovery) and the session's real choice is applied here. Never disturb a
  // runner mid-turn.
  const existing = deps.runnerRegistry.get(sessionId);
  if (existing) {
    if (!existing.running && existing.agentId !== sessionAgentId) {
      existing.agentId = sessionAgentId;
    }
    return { status: "ready", runner: existing };
  }

  const dir = session?.workspaceDir ?? null;
  if (!dir) return { status: "no-workspace" };

  // docs/161 — a `light` session kept its checkout but had its deps dropped;
  // booting the runner re-materializes node_modules via the normal
  // `agent.install` / dep-cache path, so selecting it IS the restore.
  if (session?.diskTier === "light") {
    deps.sessionManager.setDiskTier(sessionId, "hot");
  } else if (session?.remoteUrl) {
    return { status: "needs-restore", workspaceDir: dir, agentId: sessionAgentId };
  }

  return {
    status: "ready",
    runner: deps.runnerRegistry.getOrCreate(sessionId, dir, sessionAgentId),
  };
}

/**
 * Full materialization: the synchronous part, plus the workspace restore when
 * one is needed. HTTP callers want this; the WS connect path drives the two
 * halves itself so its synchronous frames keep their order.
 */
export async function materializeRunner(
  deps: MaterializeRunnerDeps,
  sessionId: string,
  fallbackAgentId: AgentId,
): Promise<MaterializeRunnerOutcome> {
  const outcome = materializeRunnerSync(deps, sessionId, fallbackAgentId);
  if (outcome.status !== "needs-restore") return outcome;
  return finishRestore(deps, sessionId, outcome);
}

/**
 * Re-materialize an evicted checkout, then create the runner.
 *
 * docs/161 / SHI-179 — a non-archived session whose workspace is missing
 * (disk-evicted, or lost to a real fs failure) must be restored from the bare
 * cache BEFORE a container boots, or the workspace bind-mount source 404s and
 * the connect → create → 404 → dispose cycle loops forever. This preserves the
 * committed branch (unlike user-archive restore). `restoreSessionWorkspace` is
 * a fast no-op when the checkout is already present.
 */
export async function finishRestore(
  deps: MaterializeRunnerDeps,
  sessionId: string,
  pending: NeedsRestore,
): Promise<MaterializeRunnerOutcome> {
  try {
    await restoreSessionWorkspace(
      deps.sessionManager,
      deps.createRepoGit,
      deps.getBareCacheDir,
      deps.githubAuthManager,
      deps.repoStore,
      sessionId,
    );
  } catch (err) {
    // Recovery is genuinely impossible (no remote / bare cache also gone).
    // Surface a terminal state instead of booting a doomed container.
    const message = getErrorMessage(err);
    console.error(`[activate] workspace restore failed for ${sessionId}:`, message);
    return { status: "restore-failed", message };
  }
  return {
    status: "ready",
    runner: deps.runnerRegistry.getOrCreate(sessionId, pending.workspaceDir, pending.agentId),
  };
}
