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

/** Make a real on-disk bare repo so fetches work without the network. */
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

/** Minimal RepoStore stub backed by an in-memory array. */
function fakeRepoStore(repos: RepoInfo[]): RepoStore {
  return {
    list: () => repos,
    get: (url: string) => repos.find((r) => r.url === url),
  } as unknown as RepoStore;
}

/** Auth stub — `authenticated: false` keeps the file:// remote untouched. */
const fakeAuth = { authenticated: false } as unknown as GitHubAuthManager;

/** Poll a sync predicate until true or the deadline expires. */
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

    // Never fetched → not covered.
    expect(pf.coveredRecently(remoteUrl)).toBe(false);

    pf.prefetchRepo(remoteUrl);
    const covered = await waitUntil(() => pf.coveredRecently(remoteUrl));
    expect(covered).toBe(true);
    // The fetch wrote the marker file the freshness check reads.
    expect(fs.existsSync(path.join(cacheDir, ".shipit-last-fetch"))).toBe(true);
  });

  it("coveredRecently is false when the last fetch is older than the skip window", async () => {
    const cacheDir = path.join(tmpDir, "cache-old");
    execSync(`git clone --bare ${remoteDir} ${cacheDir}`, { stdio: "ignore" });
    const markerPath = path.join(cacheDir, ".shipit-last-fetch");
    fs.writeFileSync(markerPath, "old");
    // Backdate the marker just past the skip window.
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
    // Fresh marker, but the repo is still cloning.
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
    // Give the fire-and-forget a moment; the marker must NOT appear.
    await new Promise((r) => setTimeout(r, 200));
    expect(fs.existsSync(path.join(cacheDir, ".shipit-last-fetch"))).toBe(false);
  });

  it("start() schedules a sweep and stop() is idempotent", () => {
    const pf = createRepoPrefetcher({
      repoStore: fakeRepoStore([]),
      getBareCacheDir: () => tmpDir,
      createRepoGit,
      githubAuthManager: fakeAuth,
    });
    // Should not throw, and double start/stop must be safe.
    pf.start();
    pf.start();
    pf.stop();
    pf.stop();
  });
});
