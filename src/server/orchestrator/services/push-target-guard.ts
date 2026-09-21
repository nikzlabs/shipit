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
  getRefHash?(ref: string): Promise<string | null>;
}

export interface SharedBranchOptions {
  /**
   * Refuse only a default branch a remote-tracking ref proves.
   *
   * `getDefaultBranch()` returns the literal "main" when it can read nothing, so
   * a repository whose origin holds no refs yet reports a default it has never
   * had. For a FORCE-push that guess is the right way to fail — an unreadable
   * remote is not a cleared one. For an ORDINARY push it is wrong: a session
   * created from a template starts on a local `main` with no recorded branch,
   * and refusing there would stop a new project publishing its first branch
   * onto the empty repository the user just pointed it at. Nothing on that
   * remote can be destroyed, because nothing is on it.
   */
  requireVerifiedDefault?: boolean;
}

export function sharedBranchMessage(branch: string, role: PushTargetRefusal["role"]): string {
  return refusal(branch, role).message;
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
  opts: SharedBranchOptions = {},
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
  if (!repoDefault || trimmed !== repoDefault) return null;
  if (opts.requireVerifiedDefault && !(await originHasBranch(git, repoDefault))) return null;
  return refusal(trimmed, "repository-default");
}

// A tracking ref is the proof: it exists only because origin reported that branch.
async function originHasBranch(git: PushTargetGit, branch: string): Promise<boolean> {
  if (!git.getRefHash) return true;
  try {
    return Boolean(await git.getRefHash(`refs/remotes/origin/${branch}`));
  } catch {
    return true;
  }
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
