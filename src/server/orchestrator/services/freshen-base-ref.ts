import type { GitManager } from "../../shared/git.js";

// Refresh the base before PR creation or re-arming: a stale ref can make shipped
// commits look new. Fetch explicitly because a clone's refspec may omit the base.
export async function freshenBaseRef(
  git: GitManager,
  baseBranch: string,
  context: string,
): Promise<boolean> {
  try {
    await git.fetchBranch("origin", baseBranch);
    return true;
  } catch (branchErr) {
    try {
      // A missing remote branch can fail the targeted fetch even when the remote is reachable.
      await git.fetch("origin");
      return true;
    } catch (remoteErr) {
      console.warn(
        `[base-ref] could not refresh origin/${baseBranch} for ${context} `
          + `(declining to decide off a possibly-stale ref):`,
        branchErr,
        remoteErr,
      );
      return false;
    }
  }
}
