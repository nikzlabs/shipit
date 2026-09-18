import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { RepoGit } from "./repo-git.js";
import { createRepoPrefetcher, CLAIM_SKIP_WINDOW_MS } from "./repo-prefetch.js";
import type { RepoStore } from "./repo-store.js";
import type { GitHubAuthManager } from "./github-auth.js";
import type { RepoInfo } from "../shared/types.js";

let tmpDir: string;
let remoteDir: string;
let remoteUrl: string;

function seedRemote(): { remoteDir: string; remoteUrl: string } {
  const seedDir = path.join(tmpDir, "seed");
  fs.mkdirSync(seedDir, { recursive: true });
  execSync("git init -b main", { cwd: seedDir, stdio: "ignore" });
  execSync("git config user.email test@example.com", { cwd: seedDir, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: seedDir, stdio: "ignore" });
  fs.writeFileSync(path.join(seedDir, "README.md"), "# test\n");
  execSync("git add . && git commit -m init --no-gpg-sign", { cwd: seedDir, stdio: "ignore" });
  const rd = path.join(tmpDir, "remote.git");
  execSync(`git clone --bare ${seedDir} ${rd}`, { stdio: "ignore" });
  return { remoteDir: rd, remoteUrl: `file://${rd}` };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-prefetch-test-"));
  ({ remoteDir, remoteUrl } = seedRemote());
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createRepoGit(dir: string): RepoGit {
  return new RepoGit(dir);
}

function fakeRepoStore(repos: RepoInfo[]): RepoStore {
  return {
    list: () => repos,
    get: (url: string) => repos.find((r) => r.url === url),
  } as unknown as RepoStore;
}

const fakeAuth = { authenticated: false } as unknown as GitHubAuthManager;

async function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return pred();
}

describe("createRepoPrefetcher", () => {
  it("coveredRecently is false before any fetch and true after prefetchRepo", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    execSync(`git clone --bare ${remoteDir} ${cacheDir}`, { stdio: "ignore" });
    const repos: RepoInfo[] = [{ url: remoteUrl, status: "ready" } as RepoInfo];
    const pf = createRepoPrefetcher({
      repoStore: fakeRepoStore(repos),
      getBareCacheDir: () => cacheDir,
      createRepoGit,
      githubAuthManager: fakeAuth,
    });

    expect(pf.coveredRecently(remoteUrl)).toBe(false);

    pf.prefetchRepo(remoteUrl);
    const covered = await waitUntil(() => pf.coveredRecently(remoteUrl));
    expect(covered).toBe(true);
    expect(fs.existsSync(path.join(cacheDir, ".shipit-last-fetch"))).toBe(true);
  });

  it("coveredRecently is false when the last fetch is older than the skip window", async () => {
    const cacheDir = path.join(tmpDir, "cache-old");
    execSync(`git clone --bare ${remoteDir} ${cacheDir}`, { stdio: "ignore" });
    const markerPath = path.join(cacheDir, ".shipit-last-fetch");
    fs.writeFileSync(markerPath, "old");
    const oldTime = new Date(Date.now() - CLAIM_SKIP_WINDOW_MS - 60_000);
    fs.utimesSync(markerPath, oldTime, oldTime);

    const repos: RepoInfo[] = [{ url: remoteUrl, status: "ready" } as RepoInfo];
    const pf = createRepoPrefetcher({
      repoStore: fakeRepoStore(repos),
      getBareCacheDir: () => cacheDir,
      createRepoGit,
      githubAuthManager: fakeAuth,
    });

    expect(pf.coveredRecently(remoteUrl)).toBe(false);
  });

  it("coveredRecently is false for a repo that is not ready", async () => {
    const cacheDir = path.join(tmpDir, "cache-cloning");
    execSync(`git clone --bare ${remoteDir} ${cacheDir}`, { stdio: "ignore" });
    fs.writeFileSync(path.join(cacheDir, ".shipit-last-fetch"), String(Date.now()));
    const repos: RepoInfo[] = [{ url: remoteUrl, status: "cloning" } as RepoInfo];
    const pf = createRepoPrefetcher({
      repoStore: fakeRepoStore(repos),
      getBareCacheDir: () => cacheDir,
      createRepoGit,
      githubAuthManager: fakeAuth,
    });

    expect(pf.coveredRecently(remoteUrl)).toBe(false);
  });

  it("prefetchRepo does not fetch a repo that is not ready", async () => {
    const cacheDir = path.join(tmpDir, "cache-notready");
    execSync(`git clone --bare ${remoteDir} ${cacheDir}`, { stdio: "ignore" });
    const repos: RepoInfo[] = [{ url: remoteUrl, status: "cloning" } as RepoInfo];
    const pf = createRepoPrefetcher({
      repoStore: fakeRepoStore(repos),
      getBareCacheDir: () => cacheDir,
      createRepoGit,
      githubAuthManager: fakeAuth,
    });

    pf.prefetchRepo(remoteUrl);
    await new Promise((r) => setTimeout(r, 200));
    expect(fs.existsSync(path.join(cacheDir, ".shipit-last-fetch"))).toBe(false);
  });

  it("coveredRecently returns false instead of throwing when the bare cache is missing", () => {
    const cacheDir = path.join(tmpDir, "cache-deleted");
    const repos: RepoInfo[] = [{ url: remoteUrl, status: "ready" } as RepoInfo];
    const pf = createRepoPrefetcher({
      repoStore: fakeRepoStore(repos),
      getBareCacheDir: () => cacheDir,
      createRepoGit,
      githubAuthManager: fakeAuth,
    });

    expect(() => pf.coveredRecently(remoteUrl)).not.toThrow();
    expect(pf.coveredRecently(remoteUrl)).toBe(false);
  });

  it("prefetchRepo re-clones a bare cache that was deleted underneath it", async () => {
    const cacheDir = path.join(tmpDir, "cache-gone");
    execSync(`git clone --bare ${remoteDir} ${cacheDir}`, { stdio: "ignore" });
    fs.rmSync(cacheDir, { recursive: true, force: true });

    const repos: RepoInfo[] = [{ url: remoteUrl, status: "ready" } as RepoInfo];
    const pf = createRepoPrefetcher({
      repoStore: fakeRepoStore(repos),
      getBareCacheDir: () => cacheDir,
      createRepoGit,
      githubAuthManager: fakeAuth,
    });

    pf.prefetchRepo(remoteUrl);
    const healed = await waitUntil(() => fs.existsSync(path.join(cacheDir, "HEAD")));
    expect(healed).toBe(true);
    expect(await waitUntil(() => pf.coveredRecently(remoteUrl))).toBe(true);
  });

  it("start() schedules a sweep and stop() is idempotent", () => {
    const pf = createRepoPrefetcher({
      repoStore: fakeRepoStore([]),
      getBareCacheDir: () => tmpDir,
      createRepoGit,
      githubAuthManager: fakeAuth,
    });
    pf.start();
    pf.start();
    pf.stop();
    pf.stop();
  });
});
