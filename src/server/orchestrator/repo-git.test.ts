import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { RepoGit, ensureBareCache } from "./repo-git.js";

let tmpDir: string;
let remoteDir: string;
let remoteUrl: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-repo-git-test-"));
  // Build a local "remote" — a real on-disk bare repo with one commit.
  // We use the file:// URL so `ensureBareCache` can `git clone --bare`
  // without touching the network.
  const seedDir = path.join(tmpDir, "seed");
  fs.mkdirSync(seedDir, { recursive: true });
  execSync("git init -b main", { cwd: seedDir, stdio: "ignore" });
  execSync("git config user.email test@example.com", { cwd: seedDir, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: seedDir, stdio: "ignore" });
  fs.writeFileSync(path.join(seedDir, "README.md"), "# test\n");
  execSync("git add . && git commit -m init --no-gpg-sign", { cwd: seedDir, stdio: "ignore" });
  remoteDir = path.join(tmpDir, "remote.git");
  execSync(`git clone --bare ${seedDir} ${remoteDir}`, { stdio: "ignore" });
  remoteUrl = `file://${remoteDir}`;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createRepoGit(dir: string): RepoGit {
  return new RepoGit(dir);
}

describe("ensureBareCache", () => {
  it("re-clones when the cache directory is missing", async () => {
    const cacheDir = path.join(tmpDir, "cache-missing");
    expect(fs.existsSync(cacheDir)).toBe(false);

    const { git, recovered } = await ensureBareCache(cacheDir, remoteUrl, createRepoGit);

    expect(recovered).toBe(true);
    expect(git).toBeDefined();
    // Valid bare repo has HEAD at the top
    expect(fs.existsSync(path.join(cacheDir, "HEAD"))).toBe(true);
    // The repo should have at least one commit (the seed README)
    expect(await git.isEmpty()).toBe(false);
  });

  it("re-clones when the cache directory exists but is empty", async () => {
    const cacheDir = path.join(tmpDir, "cache-empty");
    fs.mkdirSync(cacheDir, { recursive: true });

    const { recovered } = await ensureBareCache(cacheDir, remoteUrl, createRepoGit);

    expect(recovered).toBe(true);
    expect(fs.existsSync(path.join(cacheDir, "HEAD"))).toBe(true);
  });

  it("re-clones when the cache directory exists but has no HEAD (corrupt)", async () => {
    const cacheDir = path.join(tmpDir, "cache-corrupt");
    fs.mkdirSync(cacheDir, { recursive: true });
    // Leave behind some unrelated files but no HEAD — simulates a partial
    // download or a hand-edited cache.
    fs.writeFileSync(path.join(cacheDir, ".shipit-last-fetch"), "stale");
    fs.writeFileSync(path.join(cacheDir, "config"), "[remote]\n");

    const { recovered } = await ensureBareCache(cacheDir, remoteUrl, createRepoGit);

    expect(recovered).toBe(true);
    expect(fs.existsSync(path.join(cacheDir, "HEAD"))).toBe(true);
    // Stale marker should be wiped by the re-clone
    expect(fs.readFileSync(path.join(cacheDir, "config"), "utf-8")).not.toBe("[remote]\n");
  });

  it("returns the existing cache when HEAD is present (no re-clone)", async () => {
    const cacheDir = path.join(tmpDir, "cache-valid");
    // Set up a valid bare cache by cloning once.
    execSync(`git clone --bare ${remoteDir} ${cacheDir}`, { stdio: "ignore" });
    // Drop a marker we can use to confirm the dir was NOT wiped.
    const markerPath = path.join(cacheDir, ".keep-me");
    fs.writeFileSync(markerPath, "preserve");

    const { recovered } = await ensureBareCache(cacheDir, remoteUrl, createRepoGit);

    expect(recovered).toBe(false);
    expect(fs.existsSync(markerPath)).toBe(true);
  });
});

/** Append a commit to the seed working clone and push it to the remote. */
function advanceRemote(seedDir: string, remoteUrl: string, content: string): string {
  fs.writeFileSync(path.join(seedDir, "README.md"), content);
  execSync("git add . && git commit -m advance --no-gpg-sign", { cwd: seedDir, stdio: "ignore" });
  // seed was the clone SOURCE for remote.git, so it has no remote configured.
  execSync(`git push ${remoteUrl} HEAD:main --force`, { cwd: seedDir, stdio: "ignore" });
  return execSync("git rev-parse HEAD", { cwd: seedDir }).toString().trim();
}

describe("RepoGit bare-cache fetch advances HEAD", () => {
  it("fetchCache moves the bare cache HEAD when the remote advances", async () => {
    // Regression for docs/157: `git clone --bare` configures no fetch
    // refspec, so `git fetch --all` only writes FETCH_HEAD and the cache's
    // HEAD (→ refs/heads/main) stays frozen at clone time forever. Every
    // --local clone then branches from that stale snapshot.
    const seedDir = path.join(tmpDir, "seed");
    const cacheDir = path.join(tmpDir, "cache-advance");
    fs.mkdirSync(cacheDir, { recursive: true });
    const cacheGit = createRepoGit(cacheDir);
    await cacheGit.cloneBare(remoteUrl);

    const headBefore = await cacheGit.readHead();

    const remoteHead = advanceRemote(seedDir, remoteUrl, "# advanced\n");
    expect(remoteHead).not.toBe(headBefore);

    // ttlMs=0 bypasses the 60s freshness guard so the fetch always runs.
    await cacheGit.fetchCache(0);

    const headAfter = await cacheGit.readHead();
    expect(headAfter).toBe(remoteHead);
    expect(headAfter).not.toBe(headBefore);
  });

  it("a fresh --local clone from the cache sees the advanced commit", async () => {
    const seedDir = path.join(tmpDir, "seed");
    const cacheDir = path.join(tmpDir, "cache-clone");
    fs.mkdirSync(cacheDir, { recursive: true });
    const cacheGit = createRepoGit(cacheDir);
    await cacheGit.cloneBare(remoteUrl);

    const remoteHead = advanceRemote(seedDir, remoteUrl, "# advanced again\n");
    await cacheGit.fetchCache(0);

    const workspaceDir = path.join(tmpDir, "workspace");
    await cacheGit.cloneFromCache(workspaceDir, remoteUrl);

    const cloneOriginHead = execSync("git rev-parse origin/main", { cwd: workspaceDir })
      .toString()
      .trim();
    expect(cloneOriginHead).toBe(remoteHead);
  });
});
