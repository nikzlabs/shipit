import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  fetchAndResolveDefaultBranch,
  isGitAuthError,
  isWorkspaceCloneInSyncWithCache,
  stripUrlCredentials,
  stripRemoteUrlCredentials,
  hasUrlCredentials,
  canonicalRepoKey,
  ownerRepoFromRepoId,
  parseGitHubRemote,
  repoId,
  repoUrlToHash,
  syncLocalDefaultBranchToOrigin,
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

describe("stripRemoteUrlCredentials", () => {
  it("removes every shape a credential reaches a stored remote URL in", () => {
    for (const [typed, stored] of [
      ["https://x-access-token:pw@github.com/o/r.git", "https://github.com/o/r.git"],
      ["https://u:pw@github.com/o/r.git", "https://github.com/o/r.git"],
      ["https://github.com/o/r.git?access_token=pw", "https://github.com/o/r.git"],
      ["https://github.com/o/r.git#tok=pw", "https://github.com/o/r.git"],
      ["ssh://git:pw@example.com/o/r.git", "ssh://git@example.com/o/r.git"],
      ["ssh://git@github.com/o/r.git", "ssh://git@github.com/o/r.git"],
    ] as const) {
      expect(stripRemoteUrlCredentials(typed)).toBe(stored);
    }
  });

  it("returns a clean or unparseable URL byte-for-byte", () => {
    for (const url of [
      "https://github.com/o/r.git",
      "https://github.com",
      "git@github.com:acme/shipit.git",
      "  https://github.com/o/r.git  ",
    ]) {
      expect(stripRemoteUrlCredentials(url)).toBe(url.trim());
    }
  });

  it("agrees with hasUrlCredentials on what a credential is", () => {
    expect(hasUrlCredentials("https://u:pw@github.com/o/r.git")).toBe(true);
    expect(hasUrlCredentials("https://github.com/o/r.git?access_token=pw")).toBe(true);
    expect(hasUrlCredentials("ssh://git:pw@example.com/o/r.git")).toBe(true);
    expect(hasUrlCredentials("https://github.com/o/r.git")).toBe(false);
    expect(hasUrlCredentials("git@github.com:acme/shipit.git")).toBe(false);
  });
});

describe("repoUrlToHash", () => {
  it("hashes the two spellings of one repository to the same directory", () => {
    expect(repoUrlToHash("https://x-access-token:pw@github.com/acme/shipit.git"))
      .toBe(repoUrlToHash("https://github.com/acme/shipit.git"));
  });

  it("still separates different repositories", () => {
    expect(repoUrlToHash("https://github.com/acme/a.git"))
      .not.toBe(repoUrlToHash("https://github.com/acme/b.git"));
  });
});

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

describe("repoId", () => {
  it("collapses the spellings canonicalRepoKey does not", () => {
    const id = "github:acme/shipit";
    expect(repoId("https://github.com/acme/shipit")).toBe(id);
    expect(repoId("https://github.com/Acme/ShipIt")).toBe(id);
    expect(repoId("https://github.com/acme/shipit.git")).toBe(id);
    expect(repoId("https://github.com/acme/shipit/")).toBe(id);
    expect(repoId("git@github.com:acme/shipit.git")).toBe(id);
    expect(repoId("ssh://git@github.com/acme/shipit.git")).toBe(id);
    expect(new Set([
      canonicalRepoKey("https://github.com/Acme/ShipIt"),
      canonicalRepoKey("https://github.com/acme/shipit"),
      canonicalRepoKey("git@github.com:acme/shipit.git"),
    ]).size).toBe(3);
  });

  it("keeps dots inside a repository name", () => {
    expect(repoId("https://github.com/acme/my.git.tools")).toBe("github:acme/my.git.tools");
    expect(repoId("https://github.com/acme/foo.bar.git")).toBe("github:acme/foo.bar");
  });

  it("refuses anything it cannot parse with certainty", () => {
    expect(repoId("https://evil.example.com/github.com/acme/shipit")).toBeNull();
    expect(repoId("https://github.com.evil.example/acme/shipit")).toBeNull();
    expect(repoId("https://gitlab.com/acme/shipit")).toBeNull();
    expect(repoId("https://github.com/acme")).toBeNull();
    expect(repoId("https://github.com/acme/shipit/extra")).toBeNull();
    expect(repoId("")).toBeNull();
    expect(repoId("not a url")).toBeNull();
  });

  it("accepts a host spelled in any case — DNS is case-insensitive", () => {
    const id = "github:acme/shipit";
    expect(repoId("https://GitHub.com/acme/shipit.git")).toBe(id);
    expect(repoId("https://GITHUB.COM/Acme/ShipIt")).toBe(id);
    expect(repoId("git@GitHub.com:acme/shipit.git")).toBe(id);
    expect(repoId("https://github.com/acme/shipit.GIT")).toBe(id);
    expect(repoId("https://GitHub.com.evil.example/acme/shipit")).toBeNull();
  });

  it("reads http, userinfo and a query as the same repository — deliberately", () => {
    const id = "github:acme/shipit";
    expect(repoId("http://github.com/acme/shipit")).toBe(id);
    expect(repoId("https://github.com/acme/shipit?x=1")).toBe(id);
    expect(repoId("https://github.com/acme/shipit#readme")).toBe(id);
  });

  it("does not collapse distinct repositories", () => {
    expect(repoId("https://github.com/acme/shipit")).not.toBe(
      repoId("https://github.com/acme/other"),
    );
    expect(repoId("https://github.com/acme/shipit")).not.toBe(
      repoId("https://github.com/other/shipit"),
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

    git(tmpDir, `clone "${remoteDir}" "${cloneDir}"`);
    expect(git(cloneDir, "rev-parse HEAD")).toBe(c1);

    const c2 = commitFile(remoteDir, "shipit.yaml", "agent:\n  memory: 3072\n", "c2");
    expect(c2).not.toBe(c1);

    vi.stubEnv("PAGER", "cat");
    vi.stubEnv("GIT_PAGER", "cat");
    let result: Awaited<ReturnType<typeof fetchAndResolveDefaultBranch>>;
    try {
      result = await fetchAndResolveDefaultBranch(cloneDir);
    } finally {
      vi.unstubAllEnvs();
    }
    const { resetTarget, fetched } = result;

    expect(fetched).toBe(true);
    expect(resetTarget).toBe(c2);
    expect(git(cloneDir, `rev-parse ${resetTarget}`)).toBe(c2);
  });

  it("skipFetch resolves from local refs without hitting the network (docs/145)", async () => {
    const c1 = commitFile(remoteDir, "shipit.yaml", "agent:\n  memory: 1024\n", "c1");
    git(tmpDir, `clone "${remoteDir}" "${cloneDir}"`);
    expect(git(cloneDir, "rev-parse HEAD")).toBe(c1);

    const c2 = commitFile(remoteDir, "shipit.yaml", "agent:\n  memory: 3072\n", "c2");
    expect(c2).not.toBe(c1);

    const { resetTarget, fetched, authError } = await fetchAndResolveDefaultBranch(
      cloneDir,
      undefined,
      { skipFetch: true },
    );

    expect(fetched).toBe(false);
    expect(authError).toBe(false);
    expect(resetTarget).toBeDefined();
    expect(git(cloneDir, `rev-parse ${resetTarget}`)).toBe(c1);
  });

  it("falls back to local origin refs when the remote is unreachable (fetched: false)", async () => {
    const c1 = commitFile(remoteDir, "shipit.yaml", "agent:\n  memory: 1024\n", "c1");
    git(tmpDir, `clone "${remoteDir}" "${cloneDir}"`);

    git(cloneDir, `remote set-url origin "${path.join(tmpDir, "does-not-exist")}"`);

    const { resetTarget, fetched, authError } = await fetchAndResolveDefaultBranch(cloneDir);

    expect(fetched).toBe(false);
    expect(authError).toBe(false);
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

    git(tmpDir, `clone --bare "${remoteDir}" "${cacheDir}"`);
    git(tmpDir, `clone --local "${cacheDir}" "${workspaceDir}"`);

    expect(await isWorkspaceCloneInSyncWithCache(workspaceDir, cacheDir)).toBe(true);
  });

  it("returns false after the cache advances past the warm clone (the long-idle-pool regression)", async () => {
    commitFile(remoteDir, "README.md", "# c1\n", "c1");
    git(tmpDir, `clone --bare "${remoteDir}" "${cacheDir}"`);
    git(tmpDir, `clone --local "${cacheDir}" "${workspaceDir}"`);

    commitFile(remoteDir, "README.md", "# c2\n", "c2");
    git(cacheDir, "fetch --force origin main:main");

    expect(await isWorkspaceCloneInSyncWithCache(workspaceDir, cacheDir)).toBe(false);
  });

  it("returns false when the cache directory is missing", async () => {
    commitFile(remoteDir, "README.md", "# c1\n", "c1");
    git(tmpDir, `clone "${remoteDir}" "${workspaceDir}"`);
    expect(await isWorkspaceCloneInSyncWithCache(workspaceDir, path.join(tmpDir, "missing-cache"))).toBe(false);
  });

  it("falls back to origin/main when the clone has no origin/HEAD symbolic ref", async () => {
    commitFile(remoteDir, "README.md", "# c1\n", "c1");
    git(tmpDir, `clone --bare "${remoteDir}" "${cacheDir}"`);
    git(tmpDir, `clone --local "${cacheDir}" "${workspaceDir}"`);

    try { git(workspaceDir, "symbolic-ref -d refs/remotes/origin/HEAD"); } catch { /* ok */ }

    expect(await isWorkspaceCloneInSyncWithCache(workspaceDir, cacheDir)).toBe(true);
  });
});

describe("syncLocalDefaultBranchToOrigin", () => {
  let tmpDir: string;
  let remoteDir: string;
  let cacheDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-sync-main-"));
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

  it("moves local `main` up to origin/main after the branch was cut from a stale snapshot", async () => {
    const c1 = commitFile(remoteDir, "README.md", "# c1\n", "c1");
    git(tmpDir, `clone --bare "${remoteDir}" "${cacheDir}"`);
    git(tmpDir, `clone --local "${cacheDir}" "${workspaceDir}"`);
    git(workspaceDir, `remote set-url origin "${remoteDir}"`);
    expect(git(workspaceDir, "rev-parse main")).toBe(c1);

    const c2 = commitFile(remoteDir, "README.md", "# c2\n", "c2");
    git(workspaceDir, "fetch origin");
    git(workspaceDir, "checkout -b shipit/test origin/main");
    expect(git(workspaceDir, "rev-parse HEAD")).toBe(c2);
    expect(git(workspaceDir, "rev-parse main")).toBe(c1);

    await syncLocalDefaultBranchToOrigin(workspaceDir);

    expect(git(workspaceDir, "rev-parse main")).toBe(c2);
    expect(git(workspaceDir, "log main..HEAD --oneline")).toBe("");
  });

  it("refuses to move the checked-out default branch (no working-tree disturbance)", async () => {
    const c1 = commitFile(remoteDir, "README.md", "# c1\n", "c1");
    git(tmpDir, `clone "${remoteDir}" "${workspaceDir}"`);
    const c2 = commitFile(remoteDir, "README.md", "# c2\n", "c2");
    git(workspaceDir, "fetch origin");
    expect(git(workspaceDir, "rev-parse main")).toBe(c1);
    expect(c2).not.toBe(c1);

    await syncLocalDefaultBranchToOrigin(workspaceDir);

    expect(git(workspaceDir, "rev-parse main")).toBe(c1);
  });

  it("is a no-op when there is no origin default branch to resolve", async () => {
    commitFile(remoteDir, "README.md", "# c1\n", "c1");
    git(tmpDir, `init "${workspaceDir}"`);
    git(workspaceDir, "checkout -b shipit/test");
    git(workspaceDir, "config user.email test@test");
    git(workspaceDir, "config user.name test");
    commitFile(workspaceDir, "a.txt", "a\n", "a");

    await expect(syncLocalDefaultBranchToOrigin(workspaceDir)).resolves.toBeUndefined();
  });
});

describe("isGitAuthError", () => {
  it("recognizes the standard GitHub credential-failure strings (remote rejection only)", () => {
    expect(isGitAuthError(new Error(
      "remote: Invalid username or token. Password authentication is not supported for Git operations.\n" +
      "fatal: Authentication failed for 'https://github.com/foo/bar.git/'",
    ))).toBe(true);
    expect(isGitAuthError(new Error("Bad credentials"))).toBe(true);
    expect(isGitAuthError(new Error("HTTP/1.1 401 Unauthorized"))).toBe(true);
  });

  it("does NOT match 'no credentials sent' errors — those are client-side config problems, not remote rejection", () => {
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

describe("parseGitHubRemote", () => {
  it("keeps a dotted repository name whole, and agrees with repoId", () => {
    expect(parseGitHubRemote("https://github.com/acme/foo.bar.git"))
      .toEqual({ owner: "acme", repo: "foo.bar" });
    expect(parseGitHubRemote("git@github.com:acme/foo.bar.git"))
      .toEqual({ owner: "acme", repo: "foo.bar" });
    expect(repoId("https://github.com/acme/foo.bar.git")).toBe("github:acme/foo.bar");
  });

  it("still strips a terminal .git and stops at a path separator", () => {
    expect(parseGitHubRemote("https://github.com/acme/repo.git")).toEqual({ owner: "acme", repo: "repo" });
    expect(parseGitHubRemote("https://github.com/acme/repo")).toEqual({ owner: "acme", repo: "repo" });
    expect(parseGitHubRemote("https://github.com/acme/repo/pull/3")).toEqual({ owner: "acme", repo: "repo" });
    expect(parseGitHubRemote("git@github.com:acme/repo.git")).toEqual({ owner: "acme", repo: "repo" });
  });

  it("answers null for a non-GitHub remote", () => {
    expect(parseGitHubRemote("https://gitlab.com/acme/repo.git")).toBeNull();
  });
});

describe("ownerRepoFromRepoId", () => {
  it("inverts the identity, for the paths that must address a repository the session left", () => {
    expect(ownerRepoFromRepoId("github:acme/foo.bar")).toEqual({ owner: "acme", repo: "foo.bar" });
  });

  it("refuses anything that is not one", () => {
    expect(ownerRepoFromRepoId("github:acme/a/b")).toBeNull();
    expect(ownerRepoFromRepoId("acme/repo")).toBeNull();
    expect(ownerRepoFromRepoId("")).toBeNull();
  });
});
