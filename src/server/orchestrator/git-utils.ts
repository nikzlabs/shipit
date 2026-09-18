import crypto from "node:crypto";
import type { SimpleGit } from "simple-git";
import { safeSimpleGit } from "../shared/git-hooks-guard.js";
import {
  type GitRemoteCredentialResolver,
  credentialledGit,
  resolveTreeRemoteCredential,
  sanitizeGitEnv,
  withPreemptiveAuthFallback,
} from "../shared/git-remote-credential.js";
import type { GitManager } from "../shared/git.js";

export function generateBranchSlug(): string {
  return crypto.randomBytes(6).toString("base64url").toLowerCase().slice(0, 6);
}

export function generateBranchPrefix(): string {
  return `shipit/${  generateBranchSlug()}`;
}

export function repoUrlToHash(repoUrl: string): string {
  return crypto.createHash("sha256").update(stripRemoteUrlCredentials(repoUrl)).digest("hex").slice(0, 16);
}

// SSH usernames are login identities; only HTTP(S) userinfo is removed here.
export function stripUrlCredentials(url: string): string {
  const trimmed = (url ?? "").trim();
  try {
    const u = new URL(trimmed);
    if ((u.protocol === "http:" || u.protocol === "https:") && (u.username || u.password)) {
      u.username = "";
      u.password = "";
      return u.toString();
    }
    return trimmed;
  } catch {
    return trimmed;
  }
}

// Persistence also removes passwords from other schemes, queries and fragments.
// SCP-style remotes remain unchanged because their login cannot be distinguished from a token.
export function stripRemoteUrlCredentials(url: string): string {
  const trimmed = (url ?? "").trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed;
  }
  const isHttp = parsed.protocol === "http:" || parsed.protocol === "https:";
  const carries = Boolean((isHttp && parsed.username) || parsed.password || parsed.search || parsed.hash);
  // Preserve clean URL spelling: normalization can change a stored row key.
  if (!carries) return trimmed;
  if (isHttp) parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

export function hasUrlCredentials(url: string): boolean {
  const trimmed = (url ?? "").trim();
  return stripRemoteUrlCredentials(trimmed) !== trimmed;
}

// Comparison key only; do not persist it or use it as a clone URL.
export function canonicalRepoKey(url: string): string {
  const trimmed = (url ?? "").trim();
  try {
    const u = new URL(trimmed);
    const scheme = u.protocol.toLowerCase();
    const host = u.host.toLowerCase();
    const path = u.pathname.replace(/\/+$/, "").replace(/\.git$/i, "");
    return `${scheme}//${host}${path}`;
  } catch {
    return trimmed.toLowerCase().replace(/\/+$/, "").replace(/\.git$/i, "");
  }
}

const GITHUB_OWNER = String.raw`[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?`;
const GITHUB_REPO = String.raw`[A-Za-z0-9._-]+`;
const GITHUB_HTTPS_REMOTE = new RegExp(
  String.raw`^https?://github\.com/(${GITHUB_OWNER})/(${GITHUB_REPO}?)/?$`, "i",
);
const GITHUB_SSH_REMOTE = new RegExp(
  String.raw`^(?:ssh://)?git@github\.com[:/](${GITHUB_OWNER})/(${GITHUB_REPO}?)/?$`, "i",
);

// Authorization identity: HTTPS and SSH spellings must share the same grant.
export function repoId(url: string): string | null {
  const trimmed = stripRemoteUrlCredentials((url ?? "").trim());
  const match = GITHUB_HTTPS_REMOTE.exec(trimmed) ?? GITHUB_SSH_REMOTE.exec(trimmed);
  if (!match) return null;
  return repoIdFromOwnerRepo(match[1], match[2].replace(/\.git$/i, ""));
}

export function repoIdFromOwnerRepo(owner: string, repo: string): string | null {
  const o = (owner ?? "").trim();
  const r = (repo ?? "").trim();
  if (!new RegExp(String.raw`^${GITHUB_OWNER}$`).test(o)) return null;
  if (!new RegExp(String.raw`^${GITHUB_REPO}$`).test(r)) return null;
  if (r === "." || r === "..") return null;
  return `github:${o.toLowerCase()}/${r.toLowerCase()}`;
}

export type PushSkipReason = "no-origin" | "no-branch";

export async function pushToOrigin(
  git: GitManager,
  onSkip?: (reason: PushSkipReason) => void,
): Promise<string | null> {
  const remotes = await git.getRemotes();
  const origin = remotes.find((r) => r.name === "origin");
  if (!origin) {
    onSkip?.("no-origin");
    return null;
  }
  const branch = await git.getCurrentBranch();
  if (!branch) {
    onSkip?.("no-branch");
    return null;
  }
  await git.push("origin", branch);
  return branch;
}

const FETCH_STALL_TIMEOUT_MS = 30_000;

// Missing local credentials must not invalidate an otherwise valid stored token.
export function isGitAuthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("Authentication failed") ||
    msg.includes("Invalid username or token") ||
    msg.includes("Password authentication is not supported") ||
    msg.includes("Bad credentials") ||
    msg.includes("401 Unauthorized") ||
    /\b(403|401)\b.*(Forbidden|Unauthorized)/i.test(msg)
  );
}

// Fetch failures fall back to local refs. skipFetch also reports fetched=false.
export async function fetchAndResolveDefaultBranch(
  workspaceDir: string,
  onAuthError?: (err: Error) => unknown,
  opts?: { skipFetch?: boolean; resolveRemoteCredential?: GitRemoteCredentialResolver },
): Promise<{ resetTarget: string | undefined; fetched: boolean; fetchDurationMs: number; authError: boolean }> {
  const t0 = Date.now();
  const gitOptions = {
    timeout: { block: FETCH_STALL_TIMEOUT_MS },
    unsafe: { allowUnsafeConfigPaths: true, allowUnsafeEditor: true },
  };
  const credential = opts?.skipFetch
    ? null
    : await resolveTreeRemoteCredential(workspaceDir, "origin", opts?.resolveRemoteCredential);
  const plainGit = (): SimpleGit => safeSimpleGit(workspaceDir, gitOptions).env({
    ...sanitizeGitEnv(process.env),
    GIT_TERMINAL_PROMPT: "0",
  });
  const sg = credential ? credentialledGit(workspaceDir, credential, gitOptions) : plainGit();
  let fetched = false;
  let authError = false;
  try {
    if (opts?.skipFetch) {
      // The caller already refreshed the bare cache.
    } else {
      await withPreemptiveAuthFallback(credential, "default-branch fetch", (cred) => (
        cred ? credentialledGit(workspaceDir, cred, gitOptions) : plainGit()
      ).fetch("origin"));
      fetched = true;
    }
  } catch (err) {
    console.warn(
      `[git] fetchAndResolveDefaultBranch: origin fetch failed for ${workspaceDir} ` +
        `(resolving from local refs instead): ${err instanceof Error ? err.message : String(err)}`,
    );
    if (isGitAuthError(err)) {
      authError = true;
      onAuthError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }
  // remote set-head --auto would add another network request.
  let resetTarget: string | undefined;
  try {
    resetTarget = (await sg.raw(["rev-parse", "origin/HEAD"])).trim();
  } catch {
    for (const branch of ["origin/main", "origin/master"]) {
      try {
        resetTarget = (await sg.raw(["rev-parse", branch])).trim();
        break;
      } catch { /* try next */ }
    }
  }
  return { resetTarget, fetched, fetchDurationMs: Date.now() - t0, authError };
}

// Realign the cache snapshot's local branch so main..HEAD reflects the PR diff.
export async function syncLocalDefaultBranchToOrigin(workspaceDir: string): Promise<void> {
  const sg = safeSimpleGit(workspaceDir);
  let branch: string | undefined;
  try {
    const head = (await sg.raw(["symbolic-ref", "refs/remotes/origin/HEAD"])).trim();
    const match = /refs\/remotes\/origin\/(.+)/.exec(head);
    if (match) branch = match[1];
  } catch { /* origin/HEAD not set — fall through to probing */ }
  if (!branch) {
    for (const candidate of ["main", "master"]) {
      try {
        await sg.raw(["rev-parse", "--verify", `origin/${candidate}`]);
        branch = candidate;
        break;
      } catch { /* try next */ }
    }
  }
  if (!branch) return;
  try {
    const current = (await sg.raw(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (current === branch) return;
    await sg.raw(["branch", "-f", branch, `origin/${branch}`]);
  } catch (err) {
    console.warn(
      `[git] syncLocalDefaultBranchToOrigin: could not move ${branch} to origin/${branch} ` +
        `for ${workspaceDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// A recent cache fetch says nothing about refs in an older warm clone.
export async function isWorkspaceCloneInSyncWithCache(
  workspaceDir: string,
  cacheDir: string,
): Promise<boolean> {
  try {
    const cacheHead = (await safeSimpleGit(cacheDir).raw(["rev-parse", "HEAD"])).trim();
    if (!cacheHead) return false;
    const sg = safeSimpleGit(workspaceDir);
    for (const ref of ["origin/HEAD", "origin/main", "origin/master"]) {
      try {
        const cloneHead = (await sg.raw(["rev-parse", ref])).trim();
        if (cloneHead) return cloneHead === cacheHead;
      } catch { /* try next ref */ }
    }
    return false;
  } catch {
    return false;
  }
}

export function parseGitHubRemote(url: string): { owner: string; repo: string } | null {
  const httpsMatch = /github\.com\/([^/]+)\/([^/?#]+)/.exec(url);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2].replace(/\.git$/i, "") };
  const sshMatch = /github\.com:([^/]+)\/([^/?#]+)/.exec(url);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2].replace(/\.git$/i, "") };
  return null;
}

export function ownerRepoFromRepoId(identity: string): { owner: string; repo: string } | null {
  const match = /^github:([^/]+)\/([^/]+)$/.exec((identity ?? "").trim());
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}
