/**
 * Unit tests for repo-aware PR brokering target resolution (docs/211).
 *
 * The critical invariants:
 *  - A repo-bound session with no override is UNCHANGED (session root + session
 *    remote) — a `--local` clone's bare-cache origin must never be read.
 *  - A sandbox (no remoteUrl) resolves the cwd's clone and reads its own origin.
 *  - `--repo` targets an explicit GitHub repo while still operating on the cwd
 *    clone.
 *  - cwd → host clone mapping clamps any path-traversal back to the session root.
 *  - The git-credential gate denies only a sandbox with `git` off.
 */

import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  resolveCloneDir,
  repoFlagToUrl,
  resolvePrTarget,
  gitCredentialAllowed,
  mergeDisposition,
} from "./pr-target.js";
import type { SessionInfo } from "../shared/types.js";

const SESSION_DIR = "/srv/shipit/sessions/abc/workspace";

describe("resolveCloneDir", () => {
  it("returns the session root for an undefined cwd", () => {
    expect(resolveCloneDir(SESSION_DIR, undefined)).toBe(SESSION_DIR);
  });

  it("returns the session root when cwd is the workspace root itself", () => {
    expect(resolveCloneDir(SESSION_DIR, "/workspace")).toBe(SESSION_DIR);
  });

  it("maps a /workspace subdir to the host clone dir", () => {
    expect(resolveCloneDir(SESSION_DIR, "/workspace/myrepo")).toBe(
      path.join(SESSION_DIR, "myrepo"),
    );
  });

  it("maps a nested /workspace subdir", () => {
    expect(resolveCloneDir(SESSION_DIR, "/workspace/a/b")).toBe(
      path.join(SESSION_DIR, "a", "b"),
    );
  });

  it("treats a relative cwd as relative to the session root", () => {
    expect(resolveCloneDir(SESSION_DIR, "myrepo")).toBe(path.join(SESSION_DIR, "myrepo"));
  });

  it("clamps a traversal escape back to the session root", () => {
    expect(resolveCloneDir(SESSION_DIR, "/workspace/../../../etc")).toBe(SESSION_DIR);
    expect(resolveCloneDir(SESSION_DIR, "../../etc")).toBe(SESSION_DIR);
  });

  it("ignores an unknown absolute path (no host escape)", () => {
    expect(resolveCloneDir(SESSION_DIR, "/etc/passwd")).toBe(SESSION_DIR);
  });
});

describe("repoFlagToUrl", () => {
  it("returns undefined for absent/empty input", () => {
    expect(repoFlagToUrl(undefined)).toBeUndefined();
    expect(repoFlagToUrl("")).toBeUndefined();
    expect(repoFlagToUrl("   ")).toBeUndefined();
  });

  it("normalizes owner/name", () => {
    expect(repoFlagToUrl("octocat/hello")).toBe("https://github.com/octocat/hello.git");
  });

  it("normalizes github.com/owner/name and full URLs", () => {
    expect(repoFlagToUrl("github.com/octocat/hello")).toBe("https://github.com/octocat/hello.git");
    expect(repoFlagToUrl("https://github.com/octocat/hello.git")).toBe(
      "https://github.com/octocat/hello.git",
    );
  });

  it("returns undefined for an unparseable value", () => {
    expect(repoFlagToUrl("not-a-repo")).toBeUndefined();
  });
});

describe("resolvePrTarget", () => {
  it("repo-bound session with no override is UNCHANGED (session root + remote)", () => {
    const session = { remoteUrl: "https://github.com/o/r.git" };
    expect(resolvePrTarget(session, SESSION_DIR)).toEqual({
      gitDir: SESSION_DIR,
      remoteUrl: "https://github.com/o/r.git",
    });
  });

  it("repo-bound session ignores cwd (must not read the bare-cache origin)", () => {
    const session = { remoteUrl: "https://github.com/o/r.git" };
    // Even with a cwd, a repo-bound session keeps its root + remote.
    expect(resolvePrTarget(session, SESSION_DIR, { cwd: "/workspace/sub" })).toEqual({
      gitDir: SESSION_DIR,
      remoteUrl: "https://github.com/o/r.git",
    });
  });

  it("sandbox (no remoteUrl) resolves the cwd clone and reads its origin", () => {
    const session = { remoteUrl: "" };
    expect(resolvePrTarget(session, SESSION_DIR, { cwd: "/workspace/cloned" })).toEqual({
      gitDir: path.join(SESSION_DIR, "cloned"),
      remoteUrl: undefined,
    });
  });

  it("sandbox with no cwd falls back to the session root", () => {
    const session = { remoteUrl: "" };
    expect(resolvePrTarget(session, SESSION_DIR)).toEqual({
      gitDir: SESSION_DIR,
      remoteUrl: undefined,
    });
  });

  it("--repo targets the explicit repo while operating on the cwd clone", () => {
    const session = { remoteUrl: "" };
    expect(
      resolvePrTarget(session, SESSION_DIR, { cwd: "/workspace/cloned", repo: "octocat/hello" }),
    ).toEqual({
      gitDir: path.join(SESSION_DIR, "cloned"),
      remoteUrl: "https://github.com/octocat/hello.git",
    });
  });

  it("--repo overrides even a repo-bound session's remote", () => {
    const session = { remoteUrl: "https://github.com/o/r.git" };
    expect(resolvePrTarget(session, SESSION_DIR, { repo: "octocat/hello" })).toEqual({
      gitDir: SESSION_DIR,
      remoteUrl: "https://github.com/octocat/hello.git",
    });
  });
});

describe("gitCredentialAllowed", () => {
  it("allows a repo-bound session (no capabilities)", () => {
    expect(gitCredentialAllowed({} as SessionInfo)).toBe(true);
  });

  it("allows an ops session", () => {
    expect(gitCredentialAllowed({ kind: "ops" } as SessionInfo)).toBe(true);
  });

  it("allows a sandbox with git granted", () => {
    expect(
      gitCredentialAllowed({
        kind: "sandbox",
        capabilities: { git: true, docker: false, network: true },
      } as SessionInfo),
    ).toBe(true);
  });

  it("denies a sandbox with git off", () => {
    expect(
      gitCredentialAllowed({
        kind: "sandbox",
        capabilities: { git: false, docker: false, network: true },
      } as SessionInfo),
    ).toBe(false);
  });

  it("denies a sandbox with capabilities missing entirely", () => {
    expect(gitCredentialAllowed({ kind: "sandbox" } as SessionInfo)).toBe(false);
  });
});

describe("mergeDisposition", () => {
  it("treats a repo-bound session as not-sandbox (use the PR card)", () => {
    expect(mergeDisposition({} as SessionInfo)).toBe("not-sandbox");
  });

  it("treats an ops session as not-sandbox", () => {
    expect(mergeDisposition({ kind: "ops" } as SessionInfo)).toBe("not-sandbox");
  });

  it("allows a sandbox with the dangerousGitHubOps grant on", () => {
    expect(
      mergeDisposition({
        kind: "sandbox",
        capabilities: { git: true, docker: false, network: true, dangerousGitHubOps: true },
      } as SessionInfo),
    ).toBe("allowed");
  });

  it("reports not-granted for a sandbox with the grant off", () => {
    expect(
      mergeDisposition({
        kind: "sandbox",
        capabilities: { git: true, docker: false, network: true, dangerousGitHubOps: false },
      } as SessionInfo),
    ).toBe("not-granted");
  });

  it("reports not-granted for a sandbox with capabilities missing entirely", () => {
    expect(mergeDisposition({ kind: "sandbox" } as SessionInfo)).toBe("not-granted");
  });
});
