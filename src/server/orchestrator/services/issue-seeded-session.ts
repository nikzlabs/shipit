/**
 * Issue-seeded sessions on the **in-app** path (SHI-320).
 *
 * `createHeadlessSession` derives branch/title from an `IssueRef` before the
 * session exists, because it owns creation end to end. The Issues tab's "Start
 * session" cannot: since docs/236 it prefills the composer instead of
 * dispatching, so the session is claimed at click time and only becomes a real
 * session when the user sends the (possibly edited) first message. The issue
 * therefore has to reach graduation, not creation.
 *
 * This module is the one step that path needs: given the ref the first message
 * carried, rename the claimed session's throwaway branch to the pointer-derived
 * one and hand back the pins graduation needs so AI naming never touches either.
 * The derivation itself is NOT duplicated here — it is `seedFromIssueRef`, so
 * both paths produce the same branch for the same issue.
 */

import type { SessionManager } from "../sessions.js";
import type { GitManager } from "../../shared/git.js";
import type { IssueRef } from "../../shared/types.js";
import { seedFromIssueRef } from "./headless-sessions.js";
import { getErrorMessage } from "../validation.js";

export interface IssueSeededSessionDeps {
  sessionManager: SessionManager;
  createGitManager: (dir: string) => GitManager;
}

/**
 * Pin a just-graduating session to its issue's pointer-derived branch + title.
 *
 * Returns the values the caller must pass to `graduateSession` as
 * `explicitBranch` / `explicitTitle`. Both are always set, which is the point:
 * either one makes `graduateSession` skip AI naming, and AI naming is what
 * would otherwise rewrite the branch to a slug of the first message — a message
 * that begins with the issue's title (docs/248 req 22).
 *
 * `branch` is what the session is ACTUALLY on afterwards, not what we wanted.
 * A failed rename returns the existing throwaway branch rather than a name the
 * session row would then lie about; that still satisfies req 22 (a random
 * `shipit/<slug>` carries no issue content), it just isn't as readable.
 */
export async function pinIssueSeededSession(
  deps: IssueSeededSessionDeps,
  sessionId: string,
  issueRef: IssueRef,
): Promise<{ branch: string; title: string }> {
  const seed = seedFromIssueRef(issueRef);
  const session = deps.sessionManager.get(sessionId);
  const currentBranch = session?.branch;

  // Nothing to rename: no clone on disk, no branch recorded, or already there.
  if (!session?.workspaceDir || !currentBranch) {
    return { branch: currentBranch || seed.branch, title: seed.title };
  }
  if (currentBranch === seed.branch) return { branch: seed.branch, title: seed.title };

  try {
    await deps.createGitManager(session.workspaceDir).renameBranch(currentBranch, seed.branch);
    deps.sessionManager.setBranch(sessionId, seed.branch);
    return { branch: seed.branch, title: seed.title };
  } catch (err) {
    console.warn(
      `[issue-seeded-session] Failed to rename ${currentBranch} → ${seed.branch}: ${getErrorMessage(err)}`,
    );
    return { branch: currentBranch, title: seed.title };
  }
}
