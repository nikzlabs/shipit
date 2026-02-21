import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitManager } from "./git.js";
import { initGlobalGitConfig, setGitIdentity } from "./git-config.js";

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
