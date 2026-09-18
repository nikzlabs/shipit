import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  resolveCloneDir,
  repoFlagToUrl,
  resolvePrTarget,
  gitCredentialAllowed,
  mergeDisposition,
  agentMergeOwnership,
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
    expect(resolvePrTarget(session, SESSION_DIR, { repo: undefined })).toEqual({
      gitDir: SESSION_DIR,
      remoteUrl: "https://github.com/o/r.git",
    });
  });

  it.each([
    ["an empty string", ""],
    ["whitespace", "   "],
  ])("refuses %s — supplied-and-empty is not absent", (_label, repo) => {
    expect(() => resolvePrTarget(session, SESSION_DIR, { repo })).toThrow(/Invalid --repo/);
  });

  it.each([
    ["a number", 5],
    ["an array", ["o", "r"]],
    ["an object", { owner: "o" }],
  ])("refuses %s from a JSON body", (_label, repo) => {
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
  it("treats an ops session as not-sandbox, whatever the repository grant says", () => {
    expect(mergeDisposition({ kind: "ops" } as SessionInfo, true)).toBe("not-sandbox");
    expect(mergeDisposition({ kind: "ops" } as SessionInfo, false)).toBe("not-sandbox");
  });

  it("allows a sandbox with the dangerousGitHubOps grant on", () => {
    expect(
      mergeDisposition({
        kind: "sandbox",
        capabilities: { git: true, docker: false, network: true, dangerousGitHubOps: true },
      } as SessionInfo, false),
    ).toBe("allowed");
  });

  it("reports not-granted for a sandbox with the grant off", () => {
    expect(
      mergeDisposition({
        kind: "sandbox",
        capabilities: { git: true, docker: false, network: true, dangerousGitHubOps: false },
      } as SessionInfo, true),
    ).toBe("not-granted");
  });

  it("reports not-granted for a sandbox with capabilities missing entirely", () => {
    expect(mergeDisposition({ kind: "sandbox" } as SessionInfo, true)).toBe("not-granted");
  });

  it("lets a repo-bound session merge only where the user granted it", () => {
    expect(mergeDisposition({} as SessionInfo, true)).toBe("allowed");
    expect(mergeDisposition({} as SessionInfo, false)).toBe("not-granted-repo");
  });
});

describe("agentMergeOwnership (docs/287 req 5)", () => {
  const OK = {
    session: {
      remoteUrl: "https://github.com/acme/shipit.git",
      branch: "shipit/feature",
      prNumber: 7,
      prRepoId: "github:acme/shipit",
    },
    requestedNumber: 7,
    currentBranch: "shipit/feature",
    repoOverride: undefined,
  };

  it("allows the session's own pull request", () => {
    expect(agentMergeOwnership(OK)).toBeNull();
  });

  it("allows the ordinary call, which always carries a cwd", () => {
    expect(agentMergeOwnership({ ...OK })).toBeNull();
  });

  it("refuses --repo, which would retarget the whole operation", () => {
    const refusal = agentMergeOwnership({ ...OK, repoOverride: "other/repo" });
    expect(refusal?.status).toBe(400);
    expect(refusal?.error).toContain("--repo");
  });

  it("refuses a pull request number this session did not open", () => {
    const refusal = agentMergeOwnership({ ...OK, requestedNumber: 8 });
    expect(refusal?.status).toBe(403);
    expect(refusal?.error).toContain("#7");
  });

  it("refuses when ShipIt recorded no pull request for the session", () => {
    const refusal = agentMergeOwnership({
      ...OK,
      session: { ...OK.session, prNumber: undefined, prRepoId: undefined },
    });
    expect(refusal?.status).toBe(403);
    expect(refusal?.error).toContain("no record");
  });

  it("refuses a recorded number whose repository is no longer the session's", () => {
    const refusal = agentMergeOwnership({
      ...OK,
      session: { ...OK.session, remoteUrl: "https://github.com/acme/other.git" },
    });
    expect(refusal?.status).toBe(403);
    expect(refusal?.error).toContain("different repository");
  });

  it("accepts another spelling of the same repository", () => {
    expect(agentMergeOwnership({
      ...OK,
      session: { ...OK.session, remoteUrl: "git@GitHub.com:Acme/ShipIt.git" },
    })).toBeNull();
  });

  it("refuses when the workspace is on a different branch", () => {
    const refusal = agentMergeOwnership({ ...OK, currentBranch: "main" });
    expect(refusal?.status).toBe(409);
  });

  it("refuses a detached HEAD instead of reading it as main", () => {
    const refusal = agentMergeOwnership({
      ...OK,
      session: { ...OK.session, branch: "main" },
      currentBranch: null,
    });
    expect(refusal?.status).toBe(409);
    expect(refusal?.error).toContain("detached");
  });

  it("refuses a session whose remote has no GitHub identity", () => {
    const refusal = agentMergeOwnership({
      ...OK,
      session: { ...OK.session, remoteUrl: "https://gitlab.com/acme/shipit.git" },
    });
    expect(refusal?.status).toBe(403);
  });
});
