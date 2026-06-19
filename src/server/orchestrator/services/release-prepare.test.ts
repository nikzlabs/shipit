/**
 * docs/214 — unit tests for the release-prepare service, focused on the
 * content-free guard: a bare `shipit release prepare <bump>` (no --pick/--from)
 * resets the head branch to `origin/<release-branch>` and adds only a version
 * bump, so it would ship a release identical to the previous one. This was a real
 * footgun — a `prepare patch` cut a content-free 0.2.1.
 *
 * The git side is a hand-rolled fake (only the methods prepareRelease calls), and
 * `agentCreatePr` is mocked so no GitHub call is made. The version source is a
 * real temp `package.json` so `resolveSource`/`writeVersionToSource` work.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GitManager } from "../../shared/git.js";
import type { GitHubAuthManager } from "../github-auth.js";
import { prepareRelease } from "./release-prepare.js";

const { agentCreatePrMock } = vi.hoisted(() => ({ agentCreatePrMock: vi.fn() }));

vi.mock("./github.js", () => ({ agentCreatePr: agentCreatePrMock }));

interface GitOverrides {
  remoteBranches?: string[];
  commitsAhead?: number;
  /** Two-dot diff file count `origin/<release-branch>..HEAD` — drives the `--from` content-free guard. */
  diffFiles?: number;
  isClean?: boolean;
}

function makeGit(over: GitOverrides = {}) {
  const calls = {
    countCommitsAhead: vi.fn(async () => over.commitsAhead ?? 0),
    diffStatTwoDot: vi.fn(async () => ({ insertions: 1, deletions: 0, files: over.diffFiles ?? 1 })),
    cherryPick: vi.fn(async () => ({ success: true })),
    merge: vi.fn(async () => ({ success: true })),
    mergeOverride: vi.fn(async () => {}),
    createBranchFrom: vi.fn(async () => {}),
    commitPaths: vi.fn(async () => "deadbeefcafe"),
    forcePush: vi.fn(async () => ""),
    push: vi.fn(async () => ""),
    fetch: vi.fn(async () => {}),
    isClean: vi.fn(async () => over.isClean ?? true),
    listRemoteBranches: vi.fn(async () => over.remoteBranches ?? ["main", "stable"]),
    listTags: vi.fn(async () => [] as string[]),
    tipCommitMessage: vi.fn(async () => null),
    createAndPushTag: vi.fn(async () => {}),
    getHeadHash: vi.fn(async () => "abc123def456"),
  };
  return { git: calls as unknown as GitManager, calls };
}

const githubAuth = { authenticated: true } as unknown as GitHubAuthManager;

let dir: string;

beforeEach(() => {
  agentCreatePrMock.mockReset();
  agentCreatePrMock.mockResolvedValue({
    number: 7,
    url: "https://github.com/o/r/pull/7",
    title: "Release v0.2.1",
    baseBranch: "stable",
    headBranch: "release/0.2.1",
    insertions: 1,
    deletions: 1,
    alreadyExisted: false,
  });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-prepare-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", version: "0.2.0" }, null, 2));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("prepareRelease — content-free guard (docs/214)", () => {
  it("refuses a bare bump-only prepare (no --pick/--from brings no commits)", async () => {
    const { git, calls } = makeGit({ commitsAhead: 0 });
    await expect(
      prepareRelease(git, githubAuth, { dir, bump: "patch", releaseBranch: "stable" }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      prepareRelease(git, githubAuth, { dir, bump: "patch", releaseBranch: "stable" }),
    ).rejects.toThrow(/no changes/i);
    // We bail BEFORE bumping/committing/pushing/opening a PR.
    expect(calls.commitPaths).not.toHaveBeenCalled();
    expect(calls.forcePush).not.toHaveBeenCalled();
    expect(agentCreatePrMock).not.toHaveBeenCalled();
  });

  it("names the fix (--from / --allow-empty) in the error", async () => {
    const { git } = makeGit({ commitsAhead: 0 });
    await expect(
      prepareRelease(git, githubAuth, { dir, bump: "patch", releaseBranch: "stable" }),
    ).rejects.toThrow(/--from <branch>.*--allow-empty/s);
  });

  it("--from overrides with the incoming tree (no merge, conflict-proof) and opens the PR", async () => {
    const { git, calls } = makeGit({ diffFiles: 4 });
    const res = await prepareRelease(git, githubAuth, {
      dir,
      bump: "patch",
      releaseBranch: "stable",
      from: "main",
    });
    expect(res.kind).toBe("pr-opened");
    // It takes the override path, NOT a three-way merge (which could conflict).
    expect(calls.mergeOverride).toHaveBeenCalledWith("origin/main");
    expect(calls.merge).not.toHaveBeenCalled();
    // The content-free guard for `--from` measures the tree diff, not commit count.
    expect(calls.diffStatTwoDot).toHaveBeenCalledWith("origin/stable");
    expect(calls.countCommitsAhead).not.toHaveBeenCalled();
    expect(agentCreatePrMock).toHaveBeenCalledOnce();
  });

  it("--from whose tree equals stable (no real changes) is refused as content-free", async () => {
    const { git, calls } = makeGit({ diffFiles: 0 });
    await expect(
      prepareRelease(git, githubAuth, { dir, bump: "patch", releaseBranch: "stable", from: "main" }),
    ).rejects.toThrow(/no changes/i);
    // We bail before committing/pushing/opening a PR.
    expect(calls.commitPaths).not.toHaveBeenCalled();
    expect(agentCreatePrMock).not.toHaveBeenCalled();
  });

  it("--pick succeeds when it brings new commits", async () => {
    const { git, calls } = makeGit({ commitsAhead: 1 });
    const res = await prepareRelease(git, githubAuth, {
      dir,
      bump: "patch",
      releaseBranch: "stable",
      pick: ["abc123"],
    });
    expect(res.kind).toBe("pr-opened");
    expect(calls.cherryPick).toHaveBeenCalledWith(["abc123"]);
    expect(agentCreatePrMock).toHaveBeenCalledOnce();
  });

  it("--allow-empty permits a deliberate bump-only release", async () => {
    const { git, calls } = makeGit({ commitsAhead: 0 });
    const res = await prepareRelease(git, githubAuth, {
      dir,
      bump: "patch",
      releaseBranch: "stable",
      allowEmpty: true,
    });
    expect(res.kind).toBe("pr-opened");
    expect(calls.commitPaths).toHaveBeenCalled();
    expect(agentCreatePrMock).toHaveBeenCalledOnce();
  });

  it("--bootstrap is exempt from the guard (first release ships the new branch)", async () => {
    // stable absent → bootstrap path; commitsAhead 0 must NOT be refused.
    const { git, calls } = makeGit({ commitsAhead: 0, remoteBranches: ["main"] });
    const res = await prepareRelease(git, githubAuth, {
      dir,
      bump: "patch",
      releaseBranch: "stable",
      bootstrap: true,
    });
    expect(res.kind).toBe("pr-opened");
    // The guard is skipped entirely on bootstrap.
    expect(calls.countCommitsAhead).not.toHaveBeenCalled();
    expect(agentCreatePrMock).toHaveBeenCalledOnce();
  });
});

describe("prepareRelease — prerelease path is unaffected by the guard (docs/214)", () => {
  it("proposes an rc without --confirm and never consults the guard", async () => {
    const { git, calls } = makeGit({ commitsAhead: 0 });
    const res = await prepareRelease(git, githubAuth, {
      dir,
      bump: "patch",
      releaseBranch: "stable",
      prerelease: true,
    });
    expect(res.kind).toBe("prerelease-proposed");
    expect(calls.countCommitsAhead).not.toHaveBeenCalled();
    expect(calls.createAndPushTag).not.toHaveBeenCalled();
  });

  it("cuts the rc tag with --confirm (still no guard)", async () => {
    const { git, calls } = makeGit({ commitsAhead: 0 });
    const res = await prepareRelease(git, githubAuth, {
      dir,
      bump: "patch",
      releaseBranch: "stable",
      prerelease: true,
      confirm: true,
    });
    expect(res.kind).toBe("prerelease-tagged");
    expect(calls.createAndPushTag).toHaveBeenCalled();
    expect(calls.countCommitsAhead).not.toHaveBeenCalled();
  });
});
