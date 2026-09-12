// A restart drops the rebase driver's promise, its queue and its systemTurnInProgress
// hold together; what survives is a checkout still mid-rebase. Nothing resumed it and
// nothing said so, so the session looked ordinary while every commit and push for it
// was refused (planning#297). This sweep only reports: recovering the rebase is the
// agent's job, and it is the actor that can ask the user first. Resuming the rebase
// itself, and a Resume/Abort card, are planning#531.
import path from "node:path";
import type { GitManager } from "../shared/git.js";
import type { SessionManager } from "./sessions.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import { pathState } from "./checkout-durability.js";
import { getErrorMessage } from "./validation.js";

/**
 * Git's rebase state is all this sweep observes, so the notice claims no more than
 * that. An agent-driven rebase looks identical on disk to an abandoned one, and the
 * adoption sweep that runs first can leave one legitimately in flight.
 */
export function buildAbandonedRebaseNotice(): string {
  return (
    "[System] This session's workspace is part-way through a rebase. ShipIt found the "
    + "half-applied rebase when it started, with no turn running that owned it. Git is "
    + "holding that state, which is why commits and pushes for this session are refused.\n\n"
    + "Check it before doing anything else: run `git status` to see where the rebase "
    + "stopped. If the rebase is one you still want, resolve the conflicted files, "
    + "`git add` them, then `git rebase --continue` until it finishes. Otherwise run "
    + "`git rebase --abort`, which puts the branch back exactly as it was before the "
    + "rebase started — nothing is lost that way. Tell the user what you found and "
    + "which you did."
  );
}

export interface AbandonedRebaseSweepDeps {
  sessionManager: SessionManager;
  runnerRegistry: SessionRunnerRegistry;
  createGitManager: (dir: string) => GitManager;
}

/** Returns the ids of the sessions found mid-rebase with nothing driving them. */
export async function reportAbandonedRebases(
  deps: AbandonedRebaseSweepDeps,
): Promise<string[]> {
  const found: string[] = [];
  // allIds, not list(): list() is sidebar-filtered, and a stuck session whose PR merged
  // long ago — the shape this sweep exists for — is exactly what that filter drops.
  for (const id of deps.sessionManager.allIds()) {
    const session = deps.sessionManager.get(id);
    if (!session?.workspaceDir) continue;
    if (session.warm || session.userArchived || session.archived) continue;
    // An evicted checkout has no .git to inspect, and nothing to recover in place.
    if (session.diskTier === "evicted") continue;
    // Turn adoption runs first, so a surviving turn already owns whatever it is doing.
    if (deps.runnerRegistry.get(id)?.agentBusy) continue;
    try {
      if ((await pathState(path.join(session.workspaceDir, ".git"))) !== "present") continue;
      if (!(await deps.createGitManager(session.workspaceDir).isRebaseInProgress())) continue;
    } catch (err) {
      console.warn(`[abandoned-rebase] could not inspect ${id}:`, getErrorMessage(err));
      continue;
    }
    found.push(id);
    console.warn(`[abandoned-rebase] ${id} is mid-rebase with no turn driving it`);
    try {
      // Appends and dedupes in one transaction: overwriting would drop an unrelated
      // pending notice, and a fresh read is what makes the dedupe correct.
      deps.sessionManager.appendPendingAgentNotice(id, buildAbandonedRebaseNotice());
    } catch (err) {
      console.error(`[abandoned-rebase] recording the notice for ${id} failed:`, getErrorMessage(err));
    }
  }
  return found;
}
