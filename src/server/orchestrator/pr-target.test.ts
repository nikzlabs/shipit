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

/**
 * A supplied-but-unparseable `--repo` used to normalize to `undefined`, which
 * `resolvePrTarget` could not tell apart from "no `--repo` given" — so it fell
 * back to the session's own repository and `gh pr list --repo octocat` returned
 * the CURRENT repo's PRs with exit 0.
 */
describe("resolvePrTarget — an explicit --repo that means nothing", () => {
  const session = { remoteUrl: "https://github.com/o/r.git" };

  it.each([
    ["a bare owner with no name", "octocat"],
    ["a name with too many segments", "github.com/a/b/c"],
    ["an embedded space", "octocat/hel lo"],
  ])("refuses %s rather than falling back to the session repo", (_label, repo) => {
    expect(() => resolvePrTarget(session, SESSION_DIR, { repo })).toThrow(/Invalid --repo/);
  });

  it("names the accepted spellings in the message", () => {
    expect(() => resolvePrTarget(session, SESSION_DIR, { repo: "octocat" }))
      .toThrow(/OWNER\/NAME/);
  });

  it("raises a 400, not a 500 — it is the caller's input that is wrong", () => {
    try {
      resolvePrTarget(session, SESSION_DIR, { repo: "octocat" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as { statusCode?: number }).statusCode).toBe(400);
    }
  });

  it("still falls back to the session repo when --repo is absent", () => {
    // Absent is the caller saying nothing, not the caller saying something
    // wrong — the fallback this fix narrows must survive intact.
    expect(resolvePrTarget(session, SESSION_DIR, { repo: undefined })).toEqual({
      gitDir: SESSION_DIR,
      remoteUrl: "https://github.com/o/r.git",
    });
  });

  it.each([
    ["an empty string", ""],
    ["whitespace", "   "],
  ])("refuses %s — supplied-and-empty is not absent", (_label, repo) => {
    // `gh pr close 11 --repo "$REPO"` with an unset variable arrives here as an
    // empty string. Reading that as "no --repo given" is how it would close PR
    // 11 in whichever repository the session happens to be bound to.
    expect(() => resolvePrTarget(session, SESSION_DIR, { repo })).toThrow(/Invalid --repo/);
  });

  it.each([
    ["a number", 5],
    ["an array", ["o", "r"]],
    ["an object", { owner: "o" }],
  ])("refuses %s from a JSON body", (_label, repo) => {
    // The routes' Fastify generics are type annotations, not validation, so a
    // non-string can reach this function at runtime.
    expect(() => resolvePrTarget(session, SESSION_DIR, { repo } as unknown as { repo?: string }))
      .toThrow(/Invalid --repo/);
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
