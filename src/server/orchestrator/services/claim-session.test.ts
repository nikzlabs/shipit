import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseManager } from "../../shared/database.js";
import { SessionManager } from "../sessions.js";
import { RepoStore } from "../repo-store.js";
import type { RepoGit } from "../repo-git.js";
import type { GitHubAuthManager } from "../github-auth.js";
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
});
