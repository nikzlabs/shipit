// A restart drops the rebase driver's promise, its queue and its systemTurnInProgress
// hold together; what survives is a checkout still mid-rebase. Nothing resumed it and
// nothing said so, so the session looked ordinary while every commit and push for it
// was refused (planning#297). This sweep only reports: recovering the rebase is the
// agent's job, and it is the actor that can ask the user first. Resuming the rebase
// itself, and a Resume/Abort card, are planning#531.
import path from "node:path";
import type { GitManager } from "../shared/git.js";
import type { SessionManager } from "./sessions.js";
import { pathState } from "./checkout-durability.js";
import { getErrorMessage } from "./validation.js";

/**
 * Also the dedupe token: the notice is last-write-wins and consumed atomically by
 * the next interactive turn, so an unconsumed one means we already reported this
 * and must not report it again on the next restart.
 */
export const ABANDONED_REBASE_NOTICE_PREFIX =
  "[System] This session's workspace was left part-way through a rebase";

export function buildAbandonedRebaseNotice(): string {
  return (
    `${ABANDONED_REBASE_NOTICE_PREFIX}. A "Sync with main" was interrupted before its `
    + "conflicts were resolved — ShipIt restarted while the resolution turn was in flight, "
    + "so nothing is driving the rebase any more. The working tree still holds the "
    + "half-applied rebase and its conflict markers, which is why commits and pushes for "
    + "this session are being refused.\n\n"
    + "Recover it before doing anything else: run `git status` to see where the rebase "
    + "stopped. Either finish it — resolve the conflicted files, `git add` them, then "
    + "`git rebase --continue` until it completes — or run `git rebase --abort` to put the "
    + "branch back exactly as it was before the sync. Tell the user which you did. Nothing "
    + "was lost either way: `--abort` restores the pre-sync branch."
  );
}

export interface AbandonedRebaseSweepDeps {
  sessionManager: SessionManager;
  createGitManager: (dir: string) => GitManager;
}

/** Returns the ids of the sessions found mid-rebase, newly notified or not. */
export async function reportAbandonedRebases(
  deps: AbandonedRebaseSweepDeps,
): Promise<string[]> {
  const found: string[] = [];
  for (const session of deps.sessionManager.list()) {
    const dir = session.workspaceDir;
    if (!dir) continue;
    if (session.userArchived || session.archived) continue;
    // An evicted checkout has no .git to inspect, and nothing to recover in place.
    if (session.diskTier === "evicted") continue;
    try {
      if ((await pathState(path.join(dir, ".git"))) !== "present") continue;
      if (!(await deps.createGitManager(dir).isRebaseInProgress())) continue;
    } catch (err) {
      console.warn(
        `[abandoned-rebase] could not inspect ${session.id}:`, getErrorMessage(err),
      );
      continue;
    }
    found.push(session.id);
    if (session.pendingAgentNotice?.startsWith(ABANDONED_REBASE_NOTICE_PREFIX)) {
      console.warn(
        `[abandoned-rebase] ${session.id} is still mid-rebase; the agent notice from an `
        + "earlier start has not been consumed yet",
      );
      continue;
    }
    console.warn(
      `[abandoned-rebase] ${session.id} was left mid-rebase — telling the next turn to recover it`,
    );
    try {
      deps.sessionManager.setPendingAgentNotice(session.id, buildAbandonedRebaseNotice());
    } catch (err) {
      console.error(
        `[abandoned-rebase] recording the notice for ${session.id} failed:`, getErrorMessage(err),
      );
    }
  }
  return found;
}
