/**
 * Refuse to publish a ref the session does not own.
 *
 * Every automatic push resolves its target with `getCurrentBranch()`, so the
 * target is whatever happens to be checked out — and nothing downstream asks
 * whether that is the session's own branch. A workspace sitting on the base
 * branch therefore aims the pull-request flow's force-push at `main` itself,
 * publishing a local `main` that was frozen at clone time and deleting every
 * merge since. GitHub keeps reporting those pull requests as merged, because it
 * records the merge on the pull request and not from the branch's contents, so
 * the loss surfaces only when somebody reads the base branch by hand.
 *
 * The checkout can reach the base branch without anything going wrong in
 * ShipIt: `git checkout main` is an ordinary command, and a workspace restore
 * for a session with no recorded branch leaves the clone on its default
 * checkout, which is the default branch.
 */
export interface PushTargetGit {
  getDefaultBranch(): Promise<string>;
}

export interface PushTargetRefusal {
  branch: string;
  /** The shared branch `branch` was found to be. */
  role: "pr-base" | "repository-default";
  message: string;
}

/**
 * `baseBranch` is the base this push is for, when the caller knows it before
 * pushing. The repository default is checked as well as that base: a session on
 * `main` proposing a PR into `stable` still must not publish `main`.
 */
export async function findSharedBranchRefusal(
  git: PushTargetGit,
  branch: string,
  baseBranch?: string,
): Promise<PushTargetRefusal | null> {
  const trimmed = branch.trim();
  if (!trimmed) return null;

  if (trimmed === baseBranch?.trim()) return refusal(trimmed, "pr-base");

  // A default branch ShipIt cannot read is not a cleared one, but it is also
  // no evidence of a shared branch — the caller's own base check stands.
  let repoDefault: string;
  try {
    repoDefault = (await git.getDefaultBranch()).trim();
  } catch {
    return null;
  }
  if (repoDefault && trimmed === repoDefault) return refusal(trimmed, "repository-default");
  return null;
}

function refusal(branch: string, role: PushTargetRefusal["role"]): PushTargetRefusal {
  const what =
    role === "pr-base"
      ? "the base branch this pull request would target"
      : "this repository's default branch";
  return {
    branch,
    role,
    message:
      `This session's workspace is checked out on '${branch}', which is ${what} — not a branch `
      + "of its own. ShipIt will not push it: a session clone's copy of a shared branch is "
      + "frozen at clone time, so publishing it can silently delete work that was merged since. "
      + "Check the session's own branch back out (or start a new branch from here), then retry.",
  };
}
