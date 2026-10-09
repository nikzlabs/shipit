// planning#635 — a read that takes `.git/index.lock` makes a concurrent `git reset` or
// `git add` fail. The lock itself is not observable after the fact, so each test makes
// the index stale: a read that took the lock would then rewrite it, as the control shows.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitManager } from "./git.js";
import { runGit } from "./run-git.js";
import { sanitizeGitEnv } from "./git-remote-credential.js";
import { disableGitOptionalLocks, initGlobalGitConfig, setGitIdentity } from "../orchestrator/git-config.js";

describe("git reads and the index lock", () => {
  let tmpDir: string;
  let repoDir: string;
  let origGitConfigGlobal: string | undefined;
  let origOptionalLocks: string | undefined;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-optional-locks-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    origOptionalLocks = process.env.GIT_OPTIONAL_LOCKS;
    initGlobalGitConfig(path.join(tmpDir, "credentials"));
    setGitIdentity("Test", "test@test.com");

    repoDir = path.join(tmpDir, "repo");
    fs.mkdirSync(repoDir);
    const git = new GitManager(repoDir);
    await git.init();
    fs.writeFileSync(path.join(repoDir, "a.txt"), "one\n");
    await git.autoCommit("add a");
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    if (origOptionalLocks !== undefined) process.env.GIT_OPTIONAL_LOCKS = origOptionalLocks;
    else delete process.env.GIT_OPTIONAL_LOCKS;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const readIndex = (): Buffer => fs.readFileSync(path.join(repoDir, ".git", "index"));

  // A new mtime over unchanged content is what makes a status read want to rewrite the index.
  function makeIndexStale(): Buffer {
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(repoDir, "a.txt"), later, later);
    return readIndex();
  }

  it("control: with optional locks on, a status read rewrites the index", async () => {
    delete process.env.GIT_OPTIONAL_LOCKS;
    const before = makeIndexStale();

    await new GitManager(repoDir).inspectWorkingTree();

    expect(readIndex().equals(before)).toBe(false);
  });

  it("a status read through simple-git leaves the index alone", async () => {
    disableGitOptionalLocks();
    const before = makeIndexStale();

    const state = await new GitManager(repoDir).inspectWorkingTree();

    expect(state.clean).toBe(true);
    expect(readIndex().equals(before)).toBe(true);
  });

  it("a status read through runGit leaves the index alone, with and without a credential environment", async () => {
    disableGitOptionalLocks();
    const before = makeIndexStale();

    const plain = await runGit(["status", "--porcelain"], repoDir, 10_000);
    const credentialled = await runGit(["status", "--porcelain"], repoDir, 10_000, sanitizeGitEnv(process.env));

    expect([plain.code, credentialled.code]).toEqual([0, 0]);
    expect(readIndex().equals(before)).toBe(true);
  });
});
