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
import { buildPlanProposeInput, planRelease, prepareRelease } from "./release-prepare.js";
import type { ReleasePlan } from "./release-prepare.js";

const { agentCreatePrMock } = vi.hoisted(() => ({ agentCreatePrMock: vi.fn() }));

vi.mock("./github.js", () => ({ agentCreatePr: agentCreatePrMock }));

interface GitOverrides {
  remoteBranches?: string[];
  commitsAhead?: number;
  /** Two-dot diff file count `origin/<release-branch>..HEAD` — drives the `--from` content-free guard. */
  diffFiles?: number;
  isClean?: boolean;
  /**
   * Version on `origin/<release-branch>`'s package.json — what `showFileAtRef`
   * returns. `null`/omitted means the branch/file is absent (the anchor falls
   * back to the working tree). Drives the release-branch version anchor tests.
   */
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

/**
 * docs/214 bugfix — the release-branch version anchor. The version bump PR lands
 * only on `stable` and is never merged back to `main`, so the session working
 * tree (branched off `main`) lags every release. Computing the next version from
 * the working tree therefore proposed a version AT OR BELOW what's published
 * (e.g. working tree 0.2.0 + an already-released v0.2.2 → a regressed v0.2.1).
 * The fix anchors the current version to `origin/<release-branch>` — what's
 * released and exactly what CI reads off the merged commit.
 */
describe("release-branch version anchor (docs/214 bugfix)", () => {
  it("planRelease bumps from the release branch version, not the lagging working tree", async () => {
    // Working tree (off main) is 0.2.0 from the fixture; stable carries 0.2.2.
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
    // It anchored by reading origin/stable's version source (after a fetch).
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
    // The version actually written to the source file is the anchored one.
    const written = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { version: string };
    expect(written.version).toBe("0.2.3");
  });

  it("falls back to the working tree when the release branch has no version file yet (bootstrap)", async () => {
    // stableVersion omitted → showFileAtRef returns null → anchor falls back.
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
    // Reads the working tree (0.2.0), never consults origin/stable.
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
    // rc targets the patch above the released 0.2.2, not the working tree's 0.2.0.
    expect(res.version).toBe("0.2.3-rc.1");
    expect(res.tag).toBe("v0.2.3-rc.1");
  });
});

/**
 * docs/214 — the `POST /release/plan` route reflects the plan onto the
 * `proposed` card via this pure builder. The bug it fixes: the route dropped the
 * `mechanism`, so a `release-branch` repo's "Confirm & publish" message used the
 * tag-triggered wording. The builder must carry the mechanism through.
 */
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
