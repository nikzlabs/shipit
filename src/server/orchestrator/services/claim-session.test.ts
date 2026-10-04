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
      sseBroadcast: () => {},
    });

    await expect(service.claim(url)).rejects.toThrow("invalid index-pack output");

    expect(lastUsedAtDuringClone).toBeDefined();
    expect(Date.parse(lastUsedAtDuringClone!)).toBeGreaterThan(Date.parse(longAgo));
    expect(sessionManager.get("claimed")).toBeUndefined();
  });
});
