// Orchestrator git disables hooks, so LFS objects need an explicit upload before refs.
import type { SimpleGit } from "simple-git";

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

async function declaresLfs(git: SimpleGit, branch: string): Promise<boolean> {
  for (const ref of [branch, "HEAD"]) {
    try {
      return (await git.raw(lfsDeclarationGrepArgs(ref))).trim().length > 0;
    } catch {
      // simple-git throws for both no match and bad ref; try HEAD in either case.
      continue;
    }
  }
  return false;
}

// Use the ref push's credentialled instance: LFS authenticates separately.
// Return failures so the caller can still attempt the ref push.
export async function pushLfsObjects(
  git: SimpleGit,
  remote: string,
  branch: string,
): Promise<LfsPushOutcome> {
  if (!(await declaresLfs(git, branch))) return { status: "not-an-lfs-repo" };

  try {
    await git.raw(["lfs", "push", remote, branch]);
    return { status: "pushed" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: "failed", detail: message.trim().split("\n").slice(-3).join(" ").slice(0, 300) };
  }
}
