import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitManager } from "./git.js";
import { initGlobalGitConfig, setGitIdentity } from "../orchestrator/git-config.js";

describe("GitManager: rollback", () => {
  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-git-rollback-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    initGlobalGitConfig(tmpDir);
    setGitIdentity("Test", "test@test.com");
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resets workspace to a previous commit", async () => {
    const git = new GitManager(tmpDir);
    await git.init();

    const filePath = path.join(tmpDir, "file.txt");
    fs.writeFileSync(filePath, "original");
    await git.autoCommit("Original");

    const log1 = await git.log();
    const originalHash = log1[0].hash;

    fs.writeFileSync(filePath, "modified");
    await git.autoCommit("Modified");

    // Verify modification
    expect(fs.readFileSync(filePath, "utf-8")).toBe("modified");

    // Rollback
    await git.rollback(originalHash);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("original");
  });

  it("removes files added after the rollback target", async () => {
    const git = new GitManager(tmpDir);
    await git.init();

    const log0 = await git.log();
    const initialHash = log0[0].hash;

    fs.writeFileSync(path.join(tmpDir, "new-file.txt"), "new");
    await git.autoCommit("Add new file");

    expect(fs.existsSync(path.join(tmpDir, "new-file.txt"))).toBe(true);

    await git.rollback(initialHash);
    expect(fs.existsSync(path.join(tmpDir, "new-file.txt"))).toBe(false);
  });
});
