/**
 * Unit tests for `fetchAndResolveDefaultBranch` (W2).
 *
 * The warm pool and the claim slow-path build session clones with
 * `git clone --local` from the bare cache — a snapshot that can be far
 * behind the real remote. This helper fetches the *real* remote in the
 * workspace clone so the branch is cut from the genuine latest commit.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  fetchAndResolveDefaultBranch,
  isGitAuthError,
  isWorkspaceCloneInSyncWithCache,
  stripUrlCredentials,
  canonicalRepoKey,
} from "./git-utils.js";

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
}

function commitFile(repoDir: string, name: string, content: string, message: string): string {
  fs.writeFileSync(path.join(repoDir, name), content);
  git(repoDir, "add -A");
  git(repoDir, `commit -m "${message}" --no-gpg-sign`);
  return git(repoDir, "rev-parse HEAD");
}

describe("stripUrlCredentials", () => {
  it("removes embedded userinfo from an HTTPS URL", () => {
    expect(
      stripUrlCredentials("https://x-access-token:github_pat_ABC@github.com/acme/shipit.git"),
    ).toBe("https://github.com/acme/shipit.git");
  });

  it("leaves a clean HTTPS URL untouched", () => {
    expect(stripUrlCredentials("https://github.com/acme/shipit.git")).toBe(
      "https://github.com/acme/shipit.git",
    );
  });

  it("leaves an scp-style SSH remote untouched", () => {
    expect(stripUrlCredentials("git@github.com:acme/shipit.git")).toBe(
      "git@github.com:acme/shipit.git",
    );
  });
});

describe("canonicalRepoKey", () => {
  it("collapses credentialed, cased, and .git-suffixed forms to one key", () => {
    const clean = canonicalRepoKey("https://github.com/acme/shipit.git");
    expect(canonicalRepoKey("https://x:github_pat_X@github.com/acme/shipit")).toBe(clean);
    expect(canonicalRepoKey("https://GitHub.com/acme/shipit.git")).toBe(clean);
    expect(canonicalRepoKey("https://github.com/acme/shipit/")).toBe(clean);
  });

  it("does not collapse distinct repos", () => {
    expect(canonicalRepoKey("https://github.com/acme/shipit.git")).not.toBe(
      canonicalRepoKey("https://github.com/acme/other.git"),
    );
  });
});

describe("fetchAndResolveDefaultBranch", () => {
  let tmpDir: string;
  let remoteDir: string;
  let cloneDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-fetch-resolve-"));
    remoteDir = path.join(tmpDir, "remote");
    cloneDir = path.join(tmpDir, "clone");

    // "Real remote" repo with one commit on `main`.
    fs.mkdirSync(remoteDir, { recursive: true });
    git(remoteDir, "init");
    git(remoteDir, "checkout -b main");
    git(remoteDir, "config user.email test@test");
    git(remoteDir, "config user.name test");
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch { /* ignore */ }
  });

  it("resolves to the remote's latest commit after fetching — not the stale clone's HEAD", async () => {
    const c1 = commitFile(remoteDir, "shipit.yaml", "agent:\n  memory: 1024\n", "c1");

    // Stale clone — snapshot of the remote at c1.
    git(tmpDir, `clone "${remoteDir}" "${cloneDir}"`);
    expect(git(cloneDir, "rev-parse HEAD")).toBe(c1);

    // Remote advances — the clone has NOT seen this commit.
    const c2 = commitFile(remoteDir, "shipit.yaml", "agent:\n  memory: 3072\n", "c2");
    expect(c2).not.toBe(c1);

    const { resetTarget, fetched } = await fetchAndResolveDefaultBranch(cloneDir);

    expect(fetched).toBe(true);
    // resetTarget is `rev-parse origin/HEAD` — must be the NEW commit.
    expect(resetTarget).toBe(c2);
    expect(git(cloneDir, `rev-parse ${resetTarget}`)).toBe(c2);
  });

  it("skipFetch resolves from local refs without hitting the network (docs/145)", async () => {
    const c1 = commitFile(remoteDir, "shipit.yaml", "agent:\n  memory: 1024\n", "c1");
    git(tmpDir, `clone "${remoteDir}" "${cloneDir}"`);
    expect(git(cloneDir, "rev-parse HEAD")).toBe(c1);

    // Remote advances, but with skipFetch the clone must NOT learn about it —
    // it resolves to its local snapshot (the freshly-pre-fetched cache state).
    const c2 = commitFile(remoteDir, "shipit.yaml", "agent:\n  memory: 3072\n", "c2");
    expect(c2).not.toBe(c1);

    const { resetTarget, fetched, authError } = await fetchAndResolveDefaultBranch(
      cloneDir,
      undefined,
      { skipFetch: true },
    );

    // No network happened: fetched is false but this is a deliberate skip,
    // not a failure (authError stays false). Resolves to the local snapshot.
    expect(fetched).toBe(false);
    expect(authError).toBe(false);
    expect(resetTarget).toBeDefined();
    expect(git(cloneDir, `rev-parse ${resetTarget}`)).toBe(c1);
  });

  it("falls back to local origin refs when the remote is unreachable (fetched: false)", async () => {
    const c1 = commitFile(remoteDir, "shipit.yaml", "agent:\n  memory: 1024\n", "c1");
    git(tmpDir, `clone "${remoteDir}" "${cloneDir}"`);

    // Break origin so the fetch fails — the helper must degrade to
    // resolving from whatever `origin/*` refs the clone already has,
    // never throw.
    git(cloneDir, `remote set-url origin "${path.join(tmpDir, "does-not-exist")}"`);

    const { resetTarget, fetched, authError } = await fetchAndResolveDefaultBranch(cloneDir);

    expect(fetched).toBe(false);
    expect(authError).toBe(false); // unreachable != auth error
    // Still resolves — to the snapshot's commit (c1), the pre-W2 behavior.
    expect(resetTarget).toBeDefined();
    expect(git(cloneDir, `rev-parse ${resetTarget}`)).toBe(c1);
  });
});

describe("isWorkspaceCloneInSyncWithCache", () => {
  let tmpDir: string;
  let remoteDir: string;
  let cacheDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-clone-sync-"));
    remoteDir = path.join(tmpDir, "remote");
    cacheDir = path.join(tmpDir, "cache");
    workspaceDir = path.join(tmpDir, "workspace");

    fs.mkdirSync(remoteDir, { recursive: true });
    git(remoteDir, "init");
    git(remoteDir, "checkout -b main");
    git(remoteDir, "config user.email test@test");
    git(remoteDir, "config user.name test");
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch { /* ignore */ }
  });

  it("returns true when the clone was just cut from the bare cache (HEADs agree)", async () => {
    commitFile(remoteDir, "README.md", "# c1\n", "c1");

    // Bare cache cloned from the remote at c1, then workspace cloned from the
    // cache — mirrors the warm-pool flow at warm time.
    git(tmpDir, `clone --bare "${remoteDir}" "${cacheDir}"`);
    git(tmpDir, `clone --local "${cacheDir}" "${workspaceDir}"`);

    expect(await isWorkspaceCloneInSyncWithCache(workspaceDir, cacheDir)).toBe(true);
  });

  it("returns false after the cache advances past the warm clone (the long-idle-pool regression)", async () => {
    commitFile(remoteDir, "README.md", "# c1\n", "c1");
    git(tmpDir, `clone --bare "${remoteDir}" "${cacheDir}"`);
    // Warm session cut here — workspace's `origin/HEAD` is frozen at c1.
    git(tmpDir, `clone --local "${cacheDir}" "${workspaceDir}"`);

    // Prefetcher advances the bare cache by fetching the remote's new commits.
    commitFile(remoteDir, "README.md", "# c2\n", "c2");
    git(cacheDir, "fetch --force origin main:main");

    // The workspace clone's `origin/HEAD` still points at c1, but the cache
    // is now at c2 — the agreement check must catch this so the claim path
    // falls back to a real refresh instead of branching from c1.
    expect(await isWorkspaceCloneInSyncWithCache(workspaceDir, cacheDir)).toBe(false);
  });

  it("returns false when the cache directory is missing", async () => {
    commitFile(remoteDir, "README.md", "# c1\n", "c1");
    git(tmpDir, `clone "${remoteDir}" "${workspaceDir}"`);
    // No cache dir at all — a half-set-up state must degrade to the refresh
    // path, never to a silent skip.
    expect(await isWorkspaceCloneInSyncWithCache(workspaceDir, path.join(tmpDir, "missing-cache"))).toBe(false);
  });

  it("falls back to origin/main when the clone has no origin/HEAD symbolic ref", async () => {
    commitFile(remoteDir, "README.md", "# c1\n", "c1");
    git(tmpDir, `clone --bare "${remoteDir}" "${cacheDir}"`);
    git(tmpDir, `clone --local "${cacheDir}" "${workspaceDir}"`);

    // Older / hand-crafted clones may lack the `origin/HEAD` symbolic ref —
    // the helper must still resolve via `origin/main` / `origin/master`.
    try { git(workspaceDir, "symbolic-ref -d refs/remotes/origin/HEAD"); } catch { /* ok */ }

    expect(await isWorkspaceCloneInSyncWithCache(workspaceDir, cacheDir)).toBe(true);
  });
});

describe("isGitAuthError", () => {
  it("recognizes the standard GitHub credential-failure strings (remote rejection only)", () => {
    // The exact stderr from a `git push`/`git fetch` whose credential was
    // rejected by the remote — these are the only signals that prove the
    // server actually rejected what we sent, vs the local repo never sending
    // anything in the first place.
    expect(isGitAuthError(new Error(
      "remote: Invalid username or token. Password authentication is not supported for Git operations.\n" +
      "fatal: Authentication failed for 'https://github.com/foo/bar.git/'",
    ))).toBe(true);
    expect(isGitAuthError(new Error("Bad credentials"))).toBe(true);
    expect(isGitAuthError(new Error("HTTP/1.1 401 Unauthorized"))).toBe(true);
  });

  it("does NOT match 'no credentials sent' errors — those are client-side config problems, not remote rejection", () => {
    // These mean the local repo had no credential helper (or one that
    // returned nothing) — git never got a credential to send. A valid
    // stored token must not be cleared on these; the fix is to (re-)wire
    // up the credential helper, not to drop the token.
    expect(isGitAuthError(new Error("could not read Username for 'https://github.com'"))).toBe(false);
    expect(isGitAuthError(new Error("fatal: could not read Username for 'https://github.com': terminal prompts disabled"))).toBe(false);
  });

  it("does not match unrelated git errors", () => {
    expect(isGitAuthError(new Error("Could not resolve host: github.com"))).toBe(false);
    expect(isGitAuthError(new Error("non-fast-forward update"))).toBe(false);
    expect(isGitAuthError(new Error("merge conflict in foo.ts"))).toBe(false);
    expect(isGitAuthError(undefined)).toBe(false);
  });
});
