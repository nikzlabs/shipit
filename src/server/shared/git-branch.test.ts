import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitManager } from "./git.js";
import { generateBranchPrefix } from "../orchestrator/git-utils.js";
import { initGlobalGitConfig, setGitIdentity } from "../orchestrator/git-config.js";

describe("GitManager: branch operations", () => {
  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-git-branch-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    initGlobalGitConfig(tmpDir);
    setGitIdentity("Test", "test@test.com");
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---- checkoutNewBranch ----

  it("creates and checks out a new branch", async () => {
    const git = new GitManager(tmpDir);
    await git.init();

    await git.checkoutNewBranch("feature-branch");
    const branch = await git.getCurrentBranch();
    expect(branch).toBe("feature-branch");
  });

  it("preserves existing commits on new branch", async () => {
    const git = new GitManager(tmpDir);
    await git.init();

    fs.writeFileSync(path.join(tmpDir, "file.txt"), "content");
    await git.autoCommit("Add file");

    await git.checkoutNewBranch("new-branch");
    const log = await git.log();
    expect(log.some((c) => c.message === "Add file")).toBe(true);
  });

  // ---- renameBranch ----

  it("renames the current branch", async () => {
    const git = new GitManager(tmpDir);
    await git.init();

    await git.checkoutNewBranch("old-name");
    expect(await git.getCurrentBranch()).toBe("old-name");

    await git.renameBranch("old-name", "new-name");
    expect(await git.getCurrentBranch()).toBe("new-name");
  });
});

describe("generateBranchPrefix", () => {
  it("returns a shipit/-prefixed lowercase string with 6-char slug", () => {
    const prefix = generateBranchPrefix();
    expect(prefix).toHaveLength(13); // "shipit/" (7) + 6 random chars
    expect(prefix).toMatch(/^shipit\/[a-z0-9_-]{6}$/);
  });

  it("generates unique prefixes", () => {
    const prefixes = new Set(Array.from({ length: 20 }, () => generateBranchPrefix()));
    // With 20 random prefixes, collisions are extremely unlikely
    expect(prefixes.size).toBeGreaterThan(15);
  });
});
