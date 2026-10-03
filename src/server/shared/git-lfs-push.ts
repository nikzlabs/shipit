// Orchestrator git disables hooks, so LFS objects need an explicit upload before refs.
import type { SimpleGit } from "simple-git";
import { safeSimpleGit } from "./git-hooks-guard.js";
import { type GitRemoteCredential, gitCredentialSpawnOverrides, sanitizeGitEnv } from "./git-remote-credential.js";
import { runGit } from "./run-git.js";

const DEFAULT_LFS_TIMEOUT_MS = 300_000;
const LFS_TIMEOUT_ENV = "SHIPIT_GIT_LFS_TIMEOUT_MS";

// The ceiling on one `git lfs pull` or `git lfs push`.
export function lfsTransferTimeoutMs(): number {
  const raw = Number(process.env[LFS_TIMEOUT_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LFS_TIMEOUT_MS;
}

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
      + `pointers to files that no LFS store holds. \`git lfs push ${remote} ${ref}\` failed: ${detail}`,
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

// A server that never answers would otherwise hold the push, and the session's later pushes, forever.
// Nothing to upload is success, even when the LFS server is unreachable.
export async function pushLfsObjects(
  workspaceDir: string,
  credential: GitRemoteCredential | null,
  remote: string,
  branch: string,
): Promise<LfsPushOutcome> {
  if (!(await declaresLfs(safeSimpleGit(workspaceDir), remote, branch))) return { status: "not-an-lfs-repo" };

  const cred = gitCredentialSpawnOverrides(credential);
  const timeoutMs = lfsTransferTimeoutMs();
  // A committed `.lfsconfig` may set this to true, which makes a missing object exit 0.
  const res = await runGit(
    [...cred.args, "-c", "lfs.allowincompletepush=false", "lfs", "push", remote, branch],
    workspaceDir,
    timeoutMs,
    credential ? { ...sanitizeGitEnv(process.env), ...cred.env } : undefined,
  );
  if (res.timedOut) {
    return {
      status: "failed",
      detail: `it did not finish within ${Math.round(timeoutMs / 1000)}s (${LFS_TIMEOUT_ENV}), so ShipIt stopped it`,
    };
  }
  if (res.code === 0) return { status: "pushed" };
  // git-lfs reports missing objects on stdout. Its hints suggest disabling this check; keep the cause.
  const lines = `${res.stdout}\n${res.stderr}`.split("\n").map((l) => l.trim())
    .filter((l) => l && !/^hint:|^Uploading LFS objects:/.test(l));
  return { status: "failed", detail: lines.slice(-3).join(" ").slice(0, 300) };
}
