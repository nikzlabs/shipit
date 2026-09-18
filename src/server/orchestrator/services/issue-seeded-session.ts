import type { SessionManager } from "../sessions.js";
import type { GitManager } from "../../shared/git.js";
import type { IssueRef } from "../../shared/types.js";
import { seedFromIssueRef, isIssueSeededBranch } from "./headless-sessions.js";
import { getErrorMessage } from "../validation.js";

export interface IssueSeededSessionDeps {
  sessionManager: SessionManager;
  createGitManager: (dir: string) => GitManager;
}

/** Pass these names to graduation to keep AI naming from putting the issue title in the branch. */
export async function pinIssueSeededSession(
  deps: IssueSeededSessionDeps,
  sessionId: string,
  issueRef: IssueRef,
): Promise<{ branch: string; title: string }> {
  const seed = seedFromIssueRef(issueRef);
  const session = deps.sessionManager.get(sessionId);
  const currentBranch = session?.branch;

  if (!session?.workspaceDir || !currentBranch) {
    return { branch: currentBranch || seed.branch, title: seed.title };
  }
  // Compare the stem: each seed has a new random suffix, but re-entry must preserve the branch.
  if (isIssueSeededBranch(currentBranch, issueRef.identifier)) {
    return { branch: currentBranch, title: seed.title };
  }

  try {
    await deps.createGitManager(session.workspaceDir).renameBranch(currentBranch, seed.branch);
    deps.sessionManager.setBranch(sessionId, seed.branch);
    return { branch: seed.branch, title: seed.title };
  } catch (err) {
    // Pin the existing branch even when rename fails, so AI naming still stays off.
    console.warn(
      `[issue-seeded-session] Failed to rename ${currentBranch} → ${seed.branch}: ${getErrorMessage(err)}`,
    );
    return { branch: currentBranch, title: seed.title };
  }
}
