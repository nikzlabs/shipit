/**
 * docs/202 — re-arm a merged session for a new PR after a rebase.
 *
 * When a merged session's branch is rebased onto its base AND gains genuinely
 * new work, the stale merged PR state should be dropped and the session treated
 * as ready for a fresh PR. The detection is squash-safe and local-git-only (see
 * `GitManager.advancedBeyondMergedBase`), and is **turn-gated**: it runs once
 * per assistant turn from the post-turn flow, never from a poller sweep, so a
 * merged session that isn't progressing costs zero GitHub queries.
 *
 * This is factored into a shared helper because there are TWO post-turn entry
 * points that must both re-arm or a rebase in one of them silently fails to:
 *   - the interactive WS-handler path (`ws-handlers/agent-execution.ts`), and
 *   - the dispatch / system-turn path (`runner-registry-factory.ts`, used by
 *     spawned children, CI auto-fix, and programmatic `shipit session message`).
 * Both call this BEFORE delegating to `emitPrLifecycleAfterCommit` for the card,
 * because the re-arm needs `sseBroadcast` + the poller, neither of which is in
 * scope inside `emitPrLifecycleAfterCommit` (its deps only carry the WS `emit`).
 */

import type { GitManager } from "../../shared/git.js";
import type { SessionManager } from "../sessions.js";
import type { PrStatusPoller } from "../pr-status-poller.js";

export interface ReArmDeps {
  sessionManager: SessionManager;
  prStatusPoller: PrStatusPoller;
  createGitManager: (dir: string) => GitManager;
  sseBroadcast: (event: string, data: unknown) => void;
}

/**
 * Detect whether a MERGED session's branch has progressed past its base and, if
 * so, re-arm it. Returns true when the session was re-armed, false (no-op) for a
 * non-merged session, one without a known prior base, or a branch that hasn't
 * progressed — the common case.
 *
 * On progress:
 *   1. `clearMerged` — un-merge (clears `merged_at`) and stash the prior PR's
 *      `previousMergedPr` breadcrumb (number + url + title + baseBranch). This
 *      alone pulls the session back into Active/gray and off the fast merged
 *      eviction ladder.
 *   2. `poller.reArm` — silently clear the poller's terminal state and record
 *      the superseded PR number so the immediate forced poll can't re-promote
 *      the old merged PR before the new one opens.
 *   3. SSE `session_list` rebroadcast — the sidebar regroups from the session
 *      list over SSE only, so without this the row would stay in "Recently
 *      resolved" with the merge icon until a reload.
 *
 * The card itself (ready/creating/open, carrying the breadcrumb) is emitted by
 * `emitPrLifecycleAfterCommit` afterwards — it re-reads the now-un-merged
 * session and threads `previousMergedPr` through.
 */
export async function detectAndReArmMergedSession(args: {
  deps: ReArmDeps;
  sessionId: string;
  sessionDir: string;
}): Promise<boolean> {
  const { deps, sessionId, sessionDir } = args;
  const session = deps.sessionManager.get(sessionId);
  if (!session?.mergedAt) return false;

  // The prior merged PR drives both the detection base and the breadcrumb.
  // `getStatus` holds the merged snapshot (seeded from persisted on restart).
  const prior = deps.prStatusPoller.getStatus(sessionId);
  const baseBranch = prior?.baseBranch;
  if (!prior || !baseBranch) return false; // no known base — fail safe, stay merged

  let progressed: boolean;
  try {
    progressed = await deps.createGitManager(sessionDir).advancedBeyondMergedBase(baseBranch);
  } catch {
    return false; // workspace evicted / git error — fail safe, stay merged
  }
  if (!progressed) return false;

  deps.sessionManager.clearMerged(sessionId, {
    number: prior.prNumber,
    url: prior.prUrl,
    title: prior.prTitle,
    baseBranch,
  });
  deps.prStatusPoller.reArm(sessionId, prior.prNumber);
  deps.sseBroadcast("session_list", { sessions: deps.sessionManager.list() });
  return true;
}
