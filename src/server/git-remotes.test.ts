import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitManager } from "./git.js";

describe("GitManager: remotes", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-git-remotes-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("addRemote adds a new remote", async () => {
    const git = new GitManager(tmpDir);
    await git.init();

    await git.addRemote("origin", "https://github.com/test/repo.git");
    const remotes = await git.getRemotes();
    expect(remotes).toHaveLength(1);
    expect(remotes[0].name).toBe("origin");
    expect(remotes[0].url).toBe("https://github.com/test/repo.git");
  });

  it("addRemote updates an existing remote", async () => {
    const git = new GitManager(tmpDir);
    await git.init();

    await git.addRemote("origin", "https://github.com/test/repo1.git");
    await git.addRemote("origin", "https://github.com/test/repo2.git");

    const remotes = await git.getRemotes();
    expect(remotes).toHaveLength(1);
    expect(remotes[0].url).toBe("https://github.com/test/repo2.git");
  });

  it("getRemotes returns empty array when no remotes", async () => {
    const git = new GitManager(tmpDir);
    await git.init();

    const remotes = await git.getRemotes();
    expect(remotes).toEqual([]);
  });
});
