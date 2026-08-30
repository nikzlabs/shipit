import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitManager } from "./git.js";
import { initGlobalGitConfig, setGitIdentity } from "../orchestrator/git-config.js";

describe("GitManager: log", () => {
  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-git-log-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    initGlobalGitConfig(tmpDir);
    setGitIdentity("Test", "test@test.com");
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns commits in reverse chronological order", async () => {
    const git = new GitManager(tmpDir);
    await git.init();

    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    await git.autoCommit("First");

    fs.writeFileSync(path.join(tmpDir, "b.txt"), "b");
    await git.autoCommit("Second");

    const log = await git.log();
    expect(log[0].message).toBe("Second");
    expect(log[1].message).toBe("First");
  });

  it("respects maxCount parameter", async () => {
    const git = new GitManager(tmpDir);
    await git.init();

    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    await git.autoCommit("First");

    fs.writeFileSync(path.join(tmpDir, "b.txt"), "b");
    await git.autoCommit("Second");

    const log = await git.log(1);
    expect(log).toHaveLength(1);
    expect(log[0].message).toBe("Second");
  });

  it("returns commit info with hash, message, date, and author", async () => {
    const git = new GitManager(tmpDir);
    await git.init();

    fs.writeFileSync(path.join(tmpDir, "test.txt"), "test");
    await git.autoCommit("Test commit");

    const log = await git.log();
    const commit = log[0];
    expect(commit.hash).toMatch(/^[a-f0-9]+$/);
    expect(commit.message).toBe("Test commit");
    expect(commit.date).toBeTruthy();
    expect(commit.author).toBeTruthy();
  });
});

/**
 * The primitive the diverged-push notice uses to NAME the commits that exist
 * only on the remote (`services/push-divergence.ts`). A count alone reads as
 * bookkeeping; a subject line is what a reader recognises as their own work,
 * and this notice's whole job is to say what a force-push would destroy.
 */
describe("GitManager: commitSubjects", () => {
  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-git-subjects-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    initGlobalGitConfig(tmpDir);
    setGitIdentity("Test", "test@test.com");
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns the commits in a range, newest first, split into sha and subject", async () => {
    const git = new GitManager(tmpDir);
    await git.init();
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    await git.autoCommit("Base commit");
    const base = await git.getHeadHash();

    fs.writeFileSync(path.join(tmpDir, "b.txt"), "b");
    await git.autoCommit("Add the exporter");
    fs.writeFileSync(path.join(tmpDir, "c.txt"), "c");
    await git.autoCommit("Wire it up");

    const commits = await git.commitSubjects(`${base}..HEAD`);
    expect(commits.map((c) => c.subject)).toEqual(["Wire it up", "Add the exporter"]);
    for (const c of commits) expect(c.sha).toMatch(/^[a-f0-9]{7,}$/);
  });

  it("caps the list at maxCount", async () => {
    const git = new GitManager(tmpDir);
    await git.init();
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    await git.autoCommit("First");
    const base = await git.getHeadHash();
    for (const n of [1, 2, 3]) {
      fs.writeFileSync(path.join(tmpDir, `f${n}.txt`), String(n));
      await git.autoCommit(`Commit ${n}`);
    }

    expect(await git.commitSubjects(`${base}..HEAD`, 2)).toHaveLength(2);
  });

  it("returns an empty list rather than throwing on an unresolvable range", async () => {
    // The caller is already reporting a failure; a second one must degrade the
    // notice, not replace it with an error.
    const git = new GitManager(tmpDir);
    await git.init();
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    await git.autoCommit("First");

    expect(await git.commitSubjects("HEAD..refs/remotes/origin/nope")).toEqual([]);
  });
});
