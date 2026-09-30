// Orchestrator git disables hooks, so LFS objects need an explicit upload before refs.
import type { SimpleGit, SimpleGitOptions } from "simple-git";

// Committed attributes work in bare caches and without the git-lfs binary.
export function lfsDeclarationGrepArgs(ref = "HEAD"): string[] {
  return [
    "grep", "--ignore-case", "--fixed-strings", "-l", "-e", "filter=lfs",
    ref, "--", "*.gitattributes",
  ];
}

export type LfsPushOutcome =
  | { status: "not-an-lfs-repo" }
  | { status: "pushed" }
  | { status: "failed"; detail: string };

// Classified by this phrase in services/git.ts, so wrapped errors keep their class.
export const LFS_UPLOAD_REFUSAL = "Git LFS upload failed, so nothing was pushed";

// Refs published without their objects name content that no LFS store holds, and a
// later default `git lfs push` never retries them: it only scans commits the remote lacks.
export class LfsUploadError extends Error {
  constructor(
    readonly remote: string,
    readonly ref: string,
    readonly detail: string,
  ) {
    super(
      `${LFS_UPLOAD_REFUSAL}: pushing ${remote}/${ref} without its LFS objects would publish `
      + `pointers to files that no LFS store holds. \`git lfs push ${remote} ${ref}\` said: ${detail}`,
    );
    this.name = "LfsUploadError";
  }
}

// Needs simple-git's default leniency: a grep with no match resolves "" instead of
// falling through to HEAD, which is only for a ref that does not resolve.
async function declaresLfs(git: SimpleGit, remote: string, branch: string): Promise<boolean> {
  for (const ref of [branch, "HEAD"]) {
    try {
      if ((await git.raw(lfsDeclarationGrepArgs(ref))).trim().length > 0) return true;
      // A declaration removed by a commit the remote lacks leaves that range's pointers behind.
      const touched = await git.raw([
        "log", "--format=%H", "-G", "filter=lfs", ref, "--not", `--remotes=${remote}`, "--", "*.gitattributes",
      ]);
      return touched.trim().length > 0;
    } catch {
      continue;
    }
  }
  return false;
}

// simple-git rejects only a non-zero exit WITH stderr, and git-lfs reports missing
// objects on stdout, so the default instance resolves that failure as success.
const FAIL_ON_NONZERO_EXIT: Partial<SimpleGitOptions> = {
  errors: (error, result) => error
    ?? (result.exitCode === 0 ? undefined : Buffer.concat([...result.stdOut, ...result.stdErr])),
};

// `gitWith` builds an instance carrying the ref push's credential with these options.
// Nothing to upload is success, even when the LFS server is unreachable.
export async function pushLfsObjects(
  gitWith: (options: Partial<SimpleGitOptions>) => SimpleGit,
  remote: string,
  branch: string,
): Promise<LfsPushOutcome> {
  if (!(await declaresLfs(gitWith({}), remote, branch))) return { status: "not-an-lfs-repo" };

  try {
    // A committed `.lfsconfig` may set this to true, which makes a missing object exit 0.
    await gitWith(FAIL_ON_NONZERO_EXIT).raw(["-c", "lfs.allowincompletepush=false", "lfs", "push", remote, branch]);
    return { status: "pushed" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // git-lfs's hints suggest disabling the check this upload exists for; keep the cause.
    const lines = message.split("\n").map((l) => l.trim())
      .filter((l) => l && !/^hint:|^Uploading LFS objects:/.test(l));
    return { status: "failed", detail: lines.slice(-3).join(" ").slice(0, 300) };
  }
}
