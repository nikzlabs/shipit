import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GitManager } from "../../shared/git.js";
import type { GitHubAuthManager } from "../github-auth.js";
import { buildPlanProposeInput, planRelease, prepareRelease } from "./release-prepare.js";
import type { ReleasePlan } from "./release-prepare.js";

const { agentCreatePrMock, findBranchPullRequestMock } = vi.hoisted(() => ({
  agentCreatePrMock: vi.fn(),
  findBranchPullRequestMock: vi.fn(),
}));

vi.mock("./github.js", () => ({
  agentCreatePr: agentCreatePrMock,
  findBranchPullRequest: findBranchPullRequestMock,
}));

interface GitOverrides {
  remoteBranches?: string[];
  commitsAhead?: number;
  diffFiles?: number;
  isClean?: boolean;
  stableVersion?: string | null;
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
    getDefaultBranch: vi.fn(async () => "main"),
    listTags: vi.fn(async () => [] as string[]),
    tipCommitMessage: vi.fn(async () => null),
    createAndPushTag: vi.fn(async () => {}),
    getHeadHash: vi.fn(async () => "abc123def456"),
    showFileAtRef: vi.fn(async (_ref: string, _file: string) =>
      over.stableVersion ? JSON.stringify({ name: "x", version: over.stableVersion }) : null,
    ),
  };
  return { git: calls as unknown as GitManager, calls };
}

const githubAuth = { authenticated: true } as unknown as GitHubAuthManager;

let dir: string;

beforeEach(() => {
  agentCreatePrMock.mockReset();
  findBranchPullRequestMock.mockReset();
  findBranchPullRequestMock.mockResolvedValue(null);
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
    expect(calls.mergeOverride).toHaveBeenCalledWith("origin/main");
    expect(calls.merge).not.toHaveBeenCalled();
    expect(calls.diffStatTwoDot).toHaveBeenCalledWith("origin/stable");
    expect(calls.countCommitsAhead).not.toHaveBeenCalled();
    expect(agentCreatePrMock).toHaveBeenCalledOnce();
  });

  it("--from whose tree equals stable (no real changes) is refused as content-free", async () => {
    const { git, calls } = makeGit({ diffFiles: 0 });
    await expect(
      prepareRelease(git, githubAuth, { dir, bump: "patch", releaseBranch: "stable", from: "main" }),
    ).rejects.toThrow(/no changes/i);
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
    const { git, calls } = makeGit({ commitsAhead: 0, remoteBranches: ["main"] });
    const res = await prepareRelease(git, githubAuth, {
      dir,
      bump: "patch",
      releaseBranch: "stable",
      bootstrap: true,
    });
    expect(res.kind).toBe("pr-opened");
    expect(calls.countCommitsAhead).not.toHaveBeenCalled();
    expect(agentCreatePrMock).toHaveBeenCalledOnce();
  });
});

describe("prepareRelease — only an OPEN release PR may be reported", () => {
  type DeadReason = "merged-not-progressed" | "closed-not-progressed";
  type NotProgressed = "base-not-contained" | "no-new-work" | "base-unknown" | "fetch-failed";

  const deadPr = (alreadyExistedReason?: DeadReason, notProgressedBecause?: NotProgressed) => ({
    number: 12,
    url: "https://github.com/o/r/pull/12",
    title: "Release v0.2.0",
    baseBranch: "stable",
    headBranch: "release/0.2.1",
    insertions: 1,
    deletions: 1,
    alreadyExisted: true,
    ...(alreadyExistedReason ? { alreadyExistedReason } : {}),
    ...(notProgressedBecause ? { notProgressedBecause } : {}),
  });

  const prepareAgainstOtherBase = () =>
    prepareRelease(makeGit({ diffFiles: 4, remoteBranches: ["main", "stable", "stable-2"] }).git, githubAuth, {
      dir,
      bump: "patch",
      releaseBranch: "stable-2",
      from: "main",
    });

  async function refusalMessage(): Promise<string> {
    try {
      await prepareAgainstOtherBase();
    } catch (err: unknown) {
      return err instanceof Error ? err.message : String(err);
    }
    throw new Error("expected prepareRelease to refuse, but it resolved");
  }

  it("forwards an updated OPEN PR as alreadyExisted", async () => {
    agentCreatePrMock.mockResolvedValue({
      number: 7,
      url: "https://github.com/o/r/pull/7",
      title: "Release v0.2.1",
      baseBranch: "stable",
      headBranch: "release/0.2.1",
      insertions: 1,
      deletions: 1,
      alreadyExisted: true,
      alreadyExistedReason: "open",
    });
    const { git } = makeGit({ diffFiles: 4 });
    const res = await prepareRelease(git, githubAuth, {
      dir,
      bump: "patch",
      releaseBranch: "stable",
      from: "main",
    });
    expect(res).toMatchObject({ kind: "pr-opened", prNumber: 7, alreadyExisted: true });
  });

  it("refuses a MERGED PR instead of reporting it as an updated release", async () => {
    agentCreatePrMock.mockResolvedValue(deadPr("merged-not-progressed", "base-not-contained"));
    await expect(prepareAgainstOtherBase()).rejects.toMatchObject({ statusCode: 409 });
  });

  it("says merged, names the PR and its base, and cannot be reopened", async () => {
    agentCreatePrMock.mockResolvedValue(deadPr("merged-not-progressed", "base-not-contained"));
    await expect(prepareAgainstOtherBase()).rejects.toThrow(
      /merged pull request \(#12 into "stable"\), which GitHub cannot reopen/,
    );
  });

  it("says a CLOSED PR is one ShipIt won't reuse, not one GitHub can't reopen", async () => {
    agentCreatePrMock.mockResolvedValue(deadPr("closed-not-progressed", "base-not-contained"));
    const message = await refusalMessage();
    expect(message).toMatch(/closed pull request \(#12 into "stable"\), which ShipIt won't reuse/);
    expect(message).not.toMatch(/GitHub cannot reopen/);
  });

  it("base-not-contained points at the release branch the dead PR targeted", async () => {
    agentCreatePrMock.mockResolvedValue(deadPr("merged-not-progressed", "base-not-contained"));
    await expect(prepareAgainstOtherBase()).rejects.toThrow(/--release-branch stable/);
  });

  it("no-new-work asks for content rather than a re-run against the same base", async () => {
    agentCreatePrMock.mockResolvedValue(deadPr("merged-not-progressed", "no-new-work"));
    const message = await refusalMessage();
    expect(message).toMatch(/identical to "stable".*--from <branch>/s);
    expect(message).not.toMatch(/--release-branch/);
  });

  it("base-unknown says the base is gone rather than telling the user to re-run against it", async () => {
    agentCreatePrMock.mockResolvedValue(deadPr("merged-not-progressed", "base-unknown"));
    const message = await refusalMessage();
    expect(message).toMatch(/"stable" is no longer on the remote/);
    expect(message).not.toMatch(/--release-branch/);
  });

  it("fetch-failed blames the connection, not the release, and asks for a re-run", async () => {
    agentCreatePrMock.mockResolvedValue(deadPr("merged-not-progressed", "fetch-failed"));
    const message = await refusalMessage();
    expect(message).toMatch(/could not refresh "stable"/);
    expect(message).toMatch(/re-run the same version/);
    expect(message).not.toMatch(/Release a different version/);
    expect(message).not.toMatch(/--release-branch/);
  });

  it("refuses an existing PR whose reason is absent", async () => {
    agentCreatePrMock.mockResolvedValue(deadPr());
    await expect(prepareAgainstOtherBase()).rejects.toMatchObject({ statusCode: 409 });
  });

  it("does not claim an absent reason is 'merged' — it says only that it is not open", async () => {
    agentCreatePrMock.mockResolvedValue(deadPr());
    const message = await refusalMessage();
    expect(message).toMatch(/a pull request \(#12 into "stable"\) that is not open/);
    expect(message).not.toMatch(/merged/);
  });
});

describe("prepareRelease — the release PR must target the requested release branch", () => {
  const openPrInto = (baseBranch: string) => ({
    number: 7,
    url: "https://github.com/o/r/pull/7",
    title: "Release v0.2.1",
    baseBranch,
    headBranch: "release/0.2.1",
    insertions: 1,
    deletions: 1,
    alreadyExisted: true,
    alreadyExistedReason: "open",
  });

  const prepareInto = (releaseBranch: string) => {
    const { git, calls } = makeGit({ diffFiles: 4, remoteBranches: ["main", "stable", "stable-2"] });
    const promise = prepareRelease(git, githubAuth, { dir, bump: "patch", releaseBranch, from: "main" });
    return { promise, calls };
  };

  async function messageFrom(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
    } catch (err: unknown) {
      return err instanceof Error ? err.message : String(err);
    }
    throw new Error("expected prepareRelease to refuse, but it resolved");
  }

  it("refuses before touching the branch when the open PR targets another base", async () => {
    findBranchPullRequestMock.mockResolvedValue({ number: 7, base: "stable", state: "open", merged: false });
    const { promise, calls } = prepareInto("stable-2");
    await expect(promise).rejects.toMatchObject({ statusCode: 409 });
    expect(calls.createBranchFrom).not.toHaveBeenCalled();
    expect(calls.commitPaths).not.toHaveBeenCalled();
    expect(calls.forcePush).not.toHaveBeenCalled();
    expect(agentCreatePrMock).not.toHaveBeenCalled();
  });

  it("does not claim the bump was pushed when it refused before pushing", async () => {
    findBranchPullRequestMock.mockResolvedValue({ number: 7, base: "stable", state: "open", merged: false });
    const message = await messageFrom(prepareInto("stable-2").promise);
    expect(message).toMatch(/open pull request \(#7\) into "stable", but this release targets "stable-2"/);
    expect(message).toMatch(/wrong maintenance branch/);
    expect(message).toMatch(/--release-branch stable\b/);
    expect(message).not.toMatch(/already pushed/);
  });

  it("still refuses when the base changes after the preflight, and says the bump landed", async () => {
    findBranchPullRequestMock.mockResolvedValue(null);
    agentCreatePrMock.mockResolvedValue(openPrInto("stable"));
    const { promise, calls } = prepareInto("stable-2");
    const message = await messageFrom(promise);
    expect(calls.forcePush).toHaveBeenCalled();
    expect(message).toMatch(/already pushed to "release\/0\.2\.1".*checks are stale/s);
  });

  it("does not paste a shell-unsafe branch name into the suggested command", async () => {
    findBranchPullRequestMock.mockResolvedValue({
      number: 7,
      base: "stable;$(touch /tmp/pwned)",
      state: "open",
      merged: false,
    });
    const message = await messageFrom(prepareInto("stable-2").promise);
    expect(message).toMatch(/--release-branch <branch>/);
    expect(message).not.toMatch(/--release-branch stable;/);
    expect(message).toContain('into "stable;$(touch /tmp/pwned)"');
  });

  it("accepts an OPEN PR that does target the requested release branch", async () => {
    findBranchPullRequestMock.mockResolvedValue({ number: 7, base: "stable", state: "open", merged: false });
    agentCreatePrMock.mockResolvedValue(openPrInto("stable"));
    await expect(prepareInto("stable").promise).resolves.toMatchObject({
      kind: "pr-opened",
      prNumber: 7,
      releaseBranch: "stable",
      alreadyExisted: true,
    });
  });

  it("lets a newly opened PR through", async () => {
    agentCreatePrMock.mockResolvedValue({
      number: 9,
      url: "https://github.com/o/r/pull/9",
      title: "Release v0.2.1",
      baseBranch: "stable",
      headBranch: "release/0.2.1",
      insertions: 1,
      deletions: 1,
      alreadyExisted: false,
    });
    await expect(prepareInto("stable").promise).resolves.toMatchObject({
      kind: "pr-opened",
      prNumber: 9,
      alreadyExisted: false,
    });
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

describe("release-branch version anchor (docs/214 bugfix)", () => {
  it("planRelease bumps from the release branch version, not the lagging working tree", async () => {
    const { git, calls } = makeGit({ stableVersion: "0.2.2" });
    const plan = await planRelease(git, {
      dir,
      bump: "patch",
      mechanism: "release-branch",
      releaseBranch: "stable",
    });
    expect(plan.currentVersion).toBe("0.2.2");
    expect(plan.version).toBe("0.2.3");
    expect(plan.tag).toBe("v0.2.3");
    expect(calls.fetch).toHaveBeenCalled();
    expect(calls.showFileAtRef).toHaveBeenCalledWith("origin/stable", "package.json");
  });

  it("prepareRelease --from main writes the anchored next version into the bump", async () => {
    const { git } = makeGit({ stableVersion: "0.2.2", diffFiles: 4 });
    const res = await prepareRelease(git, githubAuth, {
      dir,
      bump: "patch",
      mechanism: "release-branch",
      releaseBranch: "stable",
      from: "main",
    });
    expect(res.kind).toBe("pr-opened");
    if (res.kind !== "pr-opened") return;
    expect(res.version).toBe("0.2.3");
    expect(res.tag).toBe("v0.2.3");
    const written = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { version: string };
    expect(written.version).toBe("0.2.3");
  });

  it("falls back to the working tree when the release branch has no version file yet (bootstrap)", async () => {
    const { git } = makeGit({ diffFiles: 4 });
    const plan = await planRelease(git, {
      dir,
      bump: "patch",
      mechanism: "release-branch",
      releaseBranch: "stable",
    });
    expect(plan.currentVersion).toBe("0.2.0");
    expect(plan.version).toBe("0.2.1");
  });

  it("does NOT anchor for a non-release-branch mechanism (main is the release source)", async () => {
    const { git, calls } = makeGit({ stableVersion: "0.2.2" });
    const plan = await planRelease(git, {
      dir,
      bump: "patch",
      mechanism: "tag-triggered",
      releaseBranch: "stable",
    });
    expect(plan.currentVersion).toBe("0.2.0");
    expect(plan.version).toBe("0.2.1");
    expect(calls.showFileAtRef).not.toHaveBeenCalled();
  });

  it("anchors the rc core to the release branch too (prerelease)", async () => {
    const { git } = makeGit({ stableVersion: "0.2.2" });
    const res = await prepareRelease(git, githubAuth, {
      dir,
      bump: "patch",
      mechanism: "release-branch",
      releaseBranch: "stable",
      prerelease: true,
    });
    expect(res.kind).toBe("prerelease-proposed");
    if (res.kind !== "prerelease-proposed") return;
    expect(res.version).toBe("0.2.3-rc.1");
    expect(res.tag).toBe("v0.2.3-rc.1");
  });
});

describe("buildPlanProposeInput (docs/214 — plan-route propose options)", () => {
  const basePlan: ReleasePlan = {
    currentVersion: "0.2.2",
    version: "0.2.3",
    tag: "v0.2.3",
    bumpType: "patch",
    versionSource: "package.json",
    versionSourcePath: "/repo/package.json",
    prerelease: false,
  };

  it("carries the mechanism for a release-branch repo", () => {
    const input = buildPlanProposeInput(basePlan, "release-branch");
    expect(input).toMatchObject({
      version: "0.2.3",
      tag: "v0.2.3",
      prerelease: false,
      bumpType: "patch",
      versionSource: "package.json",
      mechanism: "release-branch",
    });
  });

  it("omits the mechanism when none is configured (card defaults to tag-triggered)", () => {
    const input = buildPlanProposeInput(basePlan, undefined);
    expect(input).not.toHaveProperty("mechanism");
  });

  it("omits bumpType for an explicit version", () => {
    const input = buildPlanProposeInput({ ...basePlan, bumpType: "explicit" }, "release-branch");
    expect(input).not.toHaveProperty("bumpType");
    expect(input.mechanism).toBe("release-branch");
  });
});
