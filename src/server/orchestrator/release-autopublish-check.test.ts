import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { GitManager } from "../shared/git.js";
import { initGlobalGitConfig, setGitIdentity } from "./git-config.js";
import { workflowAutoPublishesOnMerge, assessMergeAutoPublish } from "./release-autopublish-check.js";

/**
 * docs/214 — cold-start guard. The pure detector decides whether a workflow's
 * `on:` fires a `push` for a branch; `assessMergeAutoPublish` reads the
 * maintenance branch's workflow over git and turns that into an actionable
 * warning. The git-backed cases prove the real bug (legacy / absent workflow on
 * the branch → merge silently no-ops) and that the `--bootstrap` cold-start
 * (branch seeded off `main`'s merge-triggered workflow) auto-publishes.
 */

// The merge-triggered workflow (main's `release.yml`): fires on a push to `stable`.
const MERGE_TRIGGERED = `name: Release
on:
  push:
    branches:
      - stable
    tags:
      - 'v*'
jobs:
  publish: {}
`;

// The legacy tag-triggered workflow (stable's current `release.yml`): tags only.
const TAG_ONLY = `name: Release
on:
  push:
    tags:
      - 'v*'
jobs:
  publish: {}
`;

describe("workflowAutoPublishesOnMerge (pure)", () => {
  it("true for the merge-triggered workflow on its branch", () => {
    expect(workflowAutoPublishesOnMerge(MERGE_TRIGGERED, "stable")).toBe(true);
  });

  it("false for the legacy tag-only workflow (the real bug)", () => {
    expect(workflowAutoPublishesOnMerge(TAG_ONLY, "stable")).toBe(false);
  });

  it("false for a missing file (cold/new repo)", () => {
    expect(workflowAutoPublishesOnMerge(null, "stable")).toBe(false);
  });

  it("false for unparseable YAML", () => {
    expect(workflowAutoPublishesOnMerge(": : not yaml : :\n  - [", "stable")).toBe(false);
  });

  it("false when the branch isn't in the push branches list", () => {
    expect(workflowAutoPublishesOnMerge(MERGE_TRIGGERED, "main")).toBe(false);
  });

  it("matches a wildcard branch pattern (release/*)", () => {
    const wf = "on:\n  push:\n    branches: ['release/*']\njobs: {}\n";
    expect(workflowAutoPublishesOnMerge(wf, "release/1.0.0")).toBe(true);
    // `*` does not cross a slash.
    expect(workflowAutoPublishesOnMerge(wf, "release/1.0.0/extra")).toBe(false);
  });

  it("matches a `**` pattern across slashes", () => {
    const wf = "on:\n  push:\n    branches: ['release/**']\njobs: {}\n";
    expect(workflowAutoPublishesOnMerge(wf, "release/1.0.0/extra")).toBe(true);
  });

  it("honors branches-ignore", () => {
    const wf = "on:\n  push:\n    branches-ignore: ['dev']\njobs: {}\n";
    expect(workflowAutoPublishesOnMerge(wf, "stable")).toBe(true);
    expect(workflowAutoPublishesOnMerge(wf, "dev")).toBe(false);
  });

  it("treats bare `on: push` (no filters) as firing on every branch", () => {
    expect(workflowAutoPublishesOnMerge("on: push\njobs: {}\n", "stable")).toBe(true);
    expect(workflowAutoPublishesOnMerge("on: [push, pull_request]\njobs: {}\n", "stable")).toBe(true);
  });

  it("treats `push:` with an empty body as firing on every branch", () => {
    expect(workflowAutoPublishesOnMerge("on:\n  push:\njobs: {}\n", "stable")).toBe(true);
  });

  it("false when there's no push trigger at all", () => {
    expect(workflowAutoPublishesOnMerge("on:\n  pull_request:\njobs: {}\n", "stable")).toBe(false);
  });
});

describe("assessMergeAutoPublish (git-backed)", () => {
  let tmpDir: string;
  let bareDir: string;
  let workDir: string;
  let origGitConfigGlobal: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-autopublish-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    initGlobalGitConfig(tmpDir);
    setGitIdentity("Test", "test@test.com");
    bareDir = path.join(tmpDir, "origin.git");
    workDir = path.join(tmpDir, "work");
    fs.mkdirSync(workDir, { recursive: true });
    execFileSync("git", ["init", "--bare", "--initial-branch=main", bareDir]);
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Seed `main` with the given workflow content (or none), push it, and create
   * `stable`. `bootstrapStableFromMain` mirrors what `prepare --bootstrap` does:
   * branch `stable` off the just-pushed `main` so it inherits main's workflow.
   */
  async function setup(opts: {
    mainWorkflow?: string;
    stableWorkflow?: string;
    bootstrapStableFromMain?: boolean;
  }): Promise<GitManager> {
    const git = new GitManager(workDir);
    await git.init();
    const wfDir = path.join(workDir, ".github", "workflows");
    fs.mkdirSync(wfDir, { recursive: true });
    if (opts.mainWorkflow) fs.writeFileSync(path.join(wfDir, "release.yml"), opts.mainWorkflow);
    fs.writeFileSync(path.join(workDir, "package.json"), '{"version":"1.0.0"}\n');
    await git.autoCommit("main commit");
    await git.addRemote("origin", bareDir);
    await git.push("origin", "main");

    if (opts.bootstrapStableFromMain) {
      // The cold-start bootstrap: stable inherits main's (merge-triggered) workflow.
      await git.createBranchFrom("stable", "origin/main");
    } else {
      await git.createBranchFrom("stable", "origin/main");
      if (opts.stableWorkflow !== undefined) {
        fs.writeFileSync(path.join(wfDir, "release.yml"), opts.stableWorkflow);
        await git.autoCommit("stable workflow");
      } else if (opts.mainWorkflow) {
        // Remove the workflow on stable to model the "no workflow on the branch" case.
        fs.rmSync(path.join(wfDir, "release.yml"));
        await git.autoCommit("drop workflow on stable");
      }
    }
    await git.push("origin", "stable");
    await git.fetch("origin");
    return git;
  }

  it("no warning when the maintenance branch carries the merge-triggered workflow", async () => {
    const git = await setup({ mainWorkflow: MERGE_TRIGGERED, stableWorkflow: MERGE_TRIGGERED });
    const res = await assessMergeAutoPublish(git, "stable");
    expect(res.canAutoPublish).toBe(true);
    expect(res.workflowPresent).toBe(true);
    expect(res.warning).toBeNull();
  });

  it("warns when the maintenance branch still has the legacy tag-only workflow", async () => {
    const git = await setup({ mainWorkflow: MERGE_TRIGGERED, stableWorkflow: TAG_ONLY });
    const res = await assessMergeAutoPublish(git, "stable");
    expect(res.canAutoPublish).toBe(false);
    expect(res.workflowPresent).toBe(true);
    expect(res.warning).toContain("will NOT auto-publish");
    expect(res.warning).toContain("legacy tag-triggered workflow");
  });

  it("warns when the maintenance branch has no workflow at all", async () => {
    const git = await setup({ mainWorkflow: undefined, stableWorkflow: undefined });
    const res = await assessMergeAutoPublish(git, "stable");
    expect(res.canAutoPublish).toBe(false);
    expect(res.workflowPresent).toBe(false);
    expect(res.warning).toContain("has no `.github/workflows/release.yml`");
    expect(res.warning).toContain("--bootstrap");
  });

  it("cold-start: a branch bootstrapped off main's merge-triggered workflow auto-publishes", async () => {
    const git = await setup({ mainWorkflow: MERGE_TRIGGERED, bootstrapStableFromMain: true });
    const res = await assessMergeAutoPublish(git, "stable");
    expect(res.canAutoPublish).toBe(true);
    expect(res.warning).toBeNull();
  });
});
