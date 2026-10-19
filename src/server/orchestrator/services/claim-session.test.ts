import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseManager } from "../../shared/database.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { RepoStore } from "../repo-store.js";
import type { RepoGit } from "../repo-git.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { SessionContainerManager } from "../session-container.js";
import { createClaimSessionService } from "./claim-session.js";

describe("createClaimSessionService", () => {
  let tmpDir: string;
  let dbManager: DatabaseManager | null = null;

  afterEach(() => {
    dbManager?.close();
    dbManager = null;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stamps the repo as used before re-cloning a reclaimed cache, and leaves no session when the clone fails", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claim-session-"));
    dbManager = new DatabaseManager(path.join(tmpDir, "test.db"));
    const sessionManager = new SessionManager(dbManager);
    const repoStore = new RepoStore(dbManager);
    const url = "https://github.com/example/dormant.git";
    const longAgo = new Date(Date.now() - 46 * 86_400_000).toISOString();
    repoStore.add(url);
    repoStore.setReady(url);
    dbManager.db.prepare("UPDATE repos SET last_used_at = ? WHERE url = ?").run(longAgo, url);

    let lastUsedAtDuringClone: string | undefined;
    let lastSessionList: { id: string }[] | undefined;
    const workspaceDir = path.join(tmpDir, "sessions", "claimed", "workspace");
    const service = createClaimSessionService({
      sessionManager,
      repoStore,
      createGitManager: () => { throw new Error("not reached"); },
      createRepoGit: () => ({
        cloneBare: () => {
          lastUsedAtDuringClone = repoStore.get(url)!.lastUsedAt;
          return Promise.reject(new Error("fetch-pack: invalid index-pack output"));
        },
      }) as unknown as RepoGit,
      githubAuthManager: { authenticated: false } as unknown as GitHubAuthManager,
      getSharedRepoDir: () => path.join(tmpDir, "repo-cache", "dormant"),
      createSessionDirFull: (title) => {
        sessionManager.track("claimed", title, workspaceDir);
        return Promise.resolve({ appSessionId: "claimed", sessionDir: path.dirname(workspaceDir), workspaceDir });
      },
      sseBroadcast: (event, data) => {
        if (event === "session_list") lastSessionList = (data as { sessions: { id: string }[] }).sessions;
      },
    });

    await expect(service.claim(url)).rejects.toThrow("invalid index-pack output");

    expect(lastUsedAtDuringClone).toBeDefined();
    expect(Date.parse(lastUsedAtDuringClone!)).toBeGreaterThan(Date.parse(longAgo));
    expect(sessionManager.get("claimed")).toBeUndefined();
    // A sidebar that saw the row while the clone ran must be told it is gone.
    expect(lastSessionList).toBeDefined();
    expect(lastSessionList!.map((s) => s.id)).not.toContain("claimed");
  });

  it("never takes the warm session when told to skip it, whose standby lacks a run's notes mount", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claim-session-"));
    dbManager = new DatabaseManager(path.join(tmpDir, "test.db"));
    const sessionManager = new SessionManager(dbManager);
    const repoStore = new RepoStore(dbManager);
    const url = "https://github.com/example/app.git";
    repoStore.add(url);
    repoStore.setReady(url);
    const warmWorkspace = path.join(tmpDir, "sessions", "warm-1", "workspace");
    fs.mkdirSync(warmWorkspace, { recursive: true });
    sessionManager.track("warm-1", "Warm session", warmWorkspace);
    repoStore.setWarmSessionId(url, "warm-1");

    let slowClones = 0;
    const service = createClaimSessionService({
      sessionManager,
      repoStore,
      // The warm path's refresh fails soft, so a claim of the warm session still succeeds.
      createGitManager: () => { throw new Error("no git here"); },
      createRepoGit: () => ({ cloneBare: () => Promise.reject(new Error("no clone here")) }) as unknown as RepoGit,
      githubAuthManager: { authenticated: false } as unknown as GitHubAuthManager,
      getSharedRepoDir: () => path.join(tmpDir, "repo-cache", "app"),
      createSessionDirFull: (title) => {
        slowClones += 1;
        const workspaceDir = path.join(tmpDir, "sessions", "fresh", "workspace");
        sessionManager.track("fresh", title, workspaceDir);
        return Promise.resolve({ appSessionId: "fresh", sessionDir: path.dirname(workspaceDir), workspaceDir });
      },
      sseBroadcast: () => {},
    });

    await expect(service.claim(url, { skipReuse: true, skipWarm: true })).rejects.toThrow("no clone here");
    expect(slowClones).toBe(1);
    expect(repoStore.get(url)!.warmSessionId).toBe("warm-1");

    const warm = await service.claim(url, { skipReuse: true });
    expect([warm.sessionId, warm.claimPath, slowClones]).toEqual(["warm-1", "warm", 1]);
  });

  it("brings the warm clone up to the cache's default branch, and never a session a claim took (docs/288 req 13)", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claim-session-"));
    dbManager = new DatabaseManager(path.join(tmpDir, "test.db"));
    const sessionManager = new SessionManager(dbManager);
    const repoStore = new RepoStore(dbManager);
    const url = "https://github.com/example/app.git";
    repoStore.add(url);
    repoStore.setReady(url);

    const git = (cwd: string, ...args: string[]): string => execFileSync(
      "git",
      ["-c", "user.email=t@t.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args],
      { cwd, encoding: "utf8" },
    ).trim();
    const remote = path.join(tmpDir, "remote");
    fs.mkdirSync(remote);
    git(remote, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(remote, "a.txt"), "a\n");
    git(remote, "add", ".");
    git(remote, "commit", "-q", "-m", "a");
    const cacheDir = path.join(tmpDir, "repo-cache", "app");
    git(tmpDir, "clone", "-q", "--bare", remote, cacheDir);
    const warmWorkspace = path.join(tmpDir, "sessions", "warm-1", "workspace");
    git(tmpDir, "clone", "-q", remote, warmWorkspace);
    git(warmWorkspace, "checkout", "-q", "-b", "shipit/warm");
    sessionManager.track("warm-1", "Warm session", warmWorkspace);
    repoStore.setWarmSessionId(url, "warm-1");

    const service = createClaimSessionService({
      sessionManager,
      repoStore,
      createGitManager: (dir) => new GitManager(dir),
      createRepoGit: () => { throw new Error("not reached"); },
      githubAuthManager: { authenticated: false, markTokenInvalid: vi.fn() } as unknown as GitHubAuthManager,
      getSharedRepoDir: () => cacheDir,
      createSessionDirFull: () => { throw new Error("not reached"); },
      sseBroadcast: () => {},
    });

    expect(await service.refreshWarm(url, "warm-1")).toEqual({ headChanged: false });

    fs.writeFileSync(path.join(remote, "b.txt"), "b\n");
    git(remote, "add", ".");
    git(remote, "commit", "-q", "-m", "b");
    git(cacheDir, "fetch", "-q", remote, "+refs/heads/*:refs/heads/*");

    expect(await service.refreshWarm(url, "warm-1")).toEqual({ headChanged: true });
    expect(git(warmWorkspace, "rev-parse", "HEAD")).toBe(git(remote, "rev-parse", "HEAD"));
    expect(git(warmWorkspace, "branch", "--show-current")).toBe("shipit/warm");

    repoStore.setWarmSessionId(url, undefined);
    expect(await service.refreshWarm(url, "warm-1")).toBeNull();
  });

  it("makes a claim wait for a warm refresh in progress, so git never runs twice in one clone", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claim-session-"));
    dbManager = new DatabaseManager(path.join(tmpDir, "test.db"));
    const sessionManager = new SessionManager(dbManager);
    const repoStore = new RepoStore(dbManager);
    const url = "https://github.com/example/app.git";
    repoStore.add(url);
    repoStore.setReady(url);
    const warmWorkspace = path.join(tmpDir, "sessions", "warm-1", "workspace");
    fs.mkdirSync(warmWorkspace, { recursive: true });
    sessionManager.track("warm-1", "Warm session", warmWorkspace);
    repoStore.setWarmSessionId(url, "warm-1");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    let releaseRefresh = (): void => {};
    const refreshHeld = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const service = createClaimSessionService({
      sessionManager,
      repoStore,
      createGitManager: () => ({
        getHeadHash: async () => { await refreshHeld; return "head"; },
      }) as unknown as GitManager,
      createRepoGit: () => { throw new Error("not reached"); },
      githubAuthManager: { authenticated: false } as unknown as GitHubAuthManager,
      getSharedRepoDir: () => path.join(tmpDir, "no-cache"),
      createSessionDirFull: () => { throw new Error("not reached"); },
      sseBroadcast: () => {},
    });

    const refresh = service.refreshWarm(url, "warm-1");
    const claim = service.claim(url);
    await new Promise((r) => setTimeout(r, 20));
    expect(repoStore.get(url)!.warmSessionId).toBe("warm-1");

    releaseRefresh();
    expect(await refresh).toEqual({ headChanged: false });
    expect((await claim).sessionId).toBe("warm-1");
  });

  it("reports the claimed session's pre-started preview on its timing line (docs/288 req 11)", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claim-session-"));
    dbManager = new DatabaseManager(path.join(tmpDir, "test.db"));
    const sessionManager = new SessionManager(dbManager);
    const repoStore = new RepoStore(dbManager);
    const url = "https://github.com/example/app.git";
    repoStore.add(url);
    repoStore.setReady(url);
    const warmWorkspace = path.join(tmpDir, "sessions", "warm-1", "workspace");
    fs.mkdirSync(warmWorkspace, { recursive: true });
    sessionManager.track("warm-1", "Warm session", warmWorkspace);
    repoStore.setWarmSessionId(url, "warm-1");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const asked: string[] = [];

    const service = createClaimSessionService({
      sessionManager,
      repoStore,
      createGitManager: () => { throw new Error("no git here"); },
      createRepoGit: () => { throw new Error("not reached"); },
      githubAuthManager: { authenticated: false } as unknown as GitHubAuthManager,
      getSharedRepoDir: () => path.join(tmpDir, "repo-cache", "app"),
      createSessionDirFull: () => { throw new Error("not reached"); },
      sseBroadcast: () => {},
      previewState: (sessionId) => { asked.push(sessionId); return "running"; },
    });

    await service.claim(url);

    expect(asked).toEqual(["warm-1"]);
    const timing = log.mock.calls.map(([m]) => String(m)).find((m) => m.startsWith("[timing] claim-session"));
    expect(timing).toContain("path=warm");
    expect(timing).toContain("preview=running");
  });

  it("still returns the session when a step after the allocation fails, because no caller could remove it", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claim-session-"));
    dbManager = new DatabaseManager(path.join(tmpDir, "test.db"));
    const sessionManager = new SessionManager(dbManager);
    const repoStore = new RepoStore(dbManager);
    const url = "https://github.com/example/app.git";
    repoStore.add(url);
    repoStore.setReady(url);
    const warmWorkspace = path.join(tmpDir, "sessions", "warm-1", "workspace");
    fs.mkdirSync(warmWorkspace, { recursive: true });
    sessionManager.track("warm-1", "Warm session", warmWorkspace);
    repoStore.setWarmSessionId(url, "warm-1");
    vi.spyOn(sessionManager, "markStarted").mockImplementation(() => {
      throw new Error("database is locked");
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const service = createClaimSessionService({
      sessionManager,
      repoStore,
      createGitManager: () => { throw new Error("no git here"); },
      createRepoGit: () => { throw new Error("not reached"); },
      githubAuthManager: { authenticated: false } as unknown as GitHubAuthManager,
      getSharedRepoDir: () => path.join(tmpDir, "repo-cache", "app"),
      createSessionDirFull: () => { throw new Error("not reached"); },
      sseBroadcast: () => {},
      shouldSkipClaimFetch: () => { throw new Error("repository store is closed"); },
      containerManager: {
        isTrackedContainerRunning: () => Promise.reject(new Error("docker is down")),
      } as unknown as SessionContainerManager,
    });

    try {
      // The pool's pointer is gone by then, so a rejection here would strand the session.
      const claimed = await service.claim(url, { skipReuse: true });

      expect([claimed.sessionId, claimed.claimPath]).toEqual(["warm-1", "warm"]);
      expect(repoStore.get(url)!.warmSessionId).toBeUndefined();
      expect(logged).toHaveBeenCalledWith(expect.any(String), "repository store is closed");
      expect(logged).toHaveBeenCalledWith(expect.stringContaining("warm-1"), "database is locked");
    } finally {
      logged.mockRestore();
    }
  });
});
