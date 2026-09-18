import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Prevent a real naming CLI from starting.
vi.mock("../session-namer.js", () => ({
  generateSessionName: vi.fn().mockResolvedValue({ name: null }),
}));

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { RepoStore } from "../repo-store.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import type { GitHubAuthManager } from "../github-auth.js";
import { DatabaseManager } from "../../shared/database.js";
import {
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  TestClient,
  createTestCredentialStore,
  createTestDatabaseManager,
  getRepoCacheDir,
  seedRepoCacheWithLocalBare,
} from "./test-helpers.js";

const SHIPIT_REPO_URL = "https://github.com/owner/shipit.git";

describe("Integration: Ops ShipIt fix-session spawn (docs/162)", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let repoStore: RepoStore;
  let dbManager: DatabaseManager;
  let github: StubGitHubAuthManager;
  let buildSha: string;
  let port: number;
  let origGitTerminalPrompt: string | undefined;
  const savedEnv = {
    dir: process.env.SHIPIT_SOURCE_DIR,
    buildId: process.env.SHIPIT_BUILD_ID,
    repoUrl: process.env.SHIPIT_SOURCE_REPO_URL,
  };

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-fix-spawn-"));
    origGitTerminalPrompt = process.env.GIT_TERMINAL_PROMPT;
    process.env.GIT_TERMINAL_PROMPT = "0";

    sessionManager = new SessionManager(dbManager);
    repoStore = new RepoStore(dbManager);
    const credentialStore = createTestCredentialStore(tmpDir);

    seedRepoCacheWithLocalBare({
      tmpDir,
      repoUrl: SHIPIT_REPO_URL,
      seedFiles: { "README.md": "# shipit\n" },
    });
    repoStore.add(SHIPIT_REPO_URL);
    repoStore.setReady(SHIPIT_REPO_URL);
    repoStore.setTrusted(SHIPIT_REPO_URL, true);

    // Use the same repository for running source and the child's cache.
    const cacheDir = getRepoCacheDir(tmpDir, SHIPIT_REPO_URL);
    buildSha = execSync("git rev-parse HEAD", { cwd: cacheDir, encoding: "utf8" }).trim();
    process.env.SHIPIT_SOURCE_DIR = cacheDir;
    process.env.SHIPIT_BUILD_ID = buildSha;
    // Override the local file URL created by the test's insteadOf redirect.
    process.env.SHIPIT_SOURCE_REPO_URL = SHIPIT_REPO_URL;

    github = new StubGitHubAuthManager();
    await github.setToken("test-token");

    app = await buildApp({
      credentialStore,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      repoStore,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: github as unknown as GitHubAuthManager,
      agentFactory: () => new FakeClaudeProcess() as never,
      workspaceDir: tmpDir,
      serveStatic: false,
    });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const match = /:(\d+)$/.exec(address);
    port = match ? Number(match[1]) : 0;
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    process.env.SHIPIT_SOURCE_DIR = savedEnv.dir;
    process.env.SHIPIT_BUILD_ID = savedEnv.buildId;
    process.env.SHIPIT_SOURCE_REPO_URL = savedEnv.repoUrl;
    if (savedEnv.dir === undefined) delete process.env.SHIPIT_SOURCE_DIR;
    if (savedEnv.buildId === undefined) delete process.env.SHIPIT_BUILD_ID;
    if (savedEnv.repoUrl === undefined) delete process.env.SHIPIT_SOURCE_REPO_URL;
    if (origGitTerminalPrompt === undefined) delete process.env.GIT_TERMINAL_PROMPT;
    else process.env.GIT_TERMINAL_PROMPT = origGitTerminalPrompt;
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // ignore cleanup errors
    }
  });

  async function createOpsParent(): Promise<string> {
    const res = await app.inject({ method: "POST", url: "/api/_test/sessions", payload: { title: "Ops" } });
    expect(res.statusCode).toBe(200);
    const { sessionId } = res.json() as { sessionId: string };
    sessionManager.setKind(sessionId, "ops");
    return sessionId;
  }

  it("spawns a writable fix child branched from the exact inspected commit", { timeout: 20_000 }, async () => {
    const parentId = await createOpsParent();
    github.setRepoWriteAccess(true);

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "Fix the container recreate loop", title: "Fix container recreate loop", shipitSource: true, spawnedByTurn: "turn-1" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      sessionId: string;
      branch: string;
      session: { parentSessionId?: string; remoteUrl?: string };
    };
    expect(body.branch).toMatch(/^shipit\//);
    expect(body.session.parentSessionId).toBe(parentId);

    const child = sessionManager.get(body.sessionId);
    expect(child?.remoteUrl).toBe(SHIPIT_REPO_URL);

    const childWorkspace = path.join(tmpDir, "sessions", body.sessionId, "workspace");
    const childHead = execSync("git rev-parse HEAD", { cwd: childWorkspace, encoding: "utf8" }).trim();
    expect(childHead).toBe(buildSha);
  });

  it("requires an explicit --title and uses it verbatim (not the incident-packet header)", { timeout: 20_000 }, async () => {
    const parentId = await createOpsParent();
    github.setRepoWriteAccess(true);

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: {
        prompt: "Preview pane never reloads after editing shipit.yaml\n\nrepro steps...",
        title: "Fix preview reload on shipit.yaml edit",
        shipitSource: true,
        spawnedByTurn: "turn-1",
      },
    });
    expect(res.statusCode).toBe(200);
    const { sessionId } = res.json() as { sessionId: string };

    const child = sessionManager.get(sessionId);
    expect(child?.title).toBe("Fix preview reload on shipit.yaml edit");
    expect(child?.title).not.toMatch(/Ops remediation/);
  });

  it("rejects a ShipIt fix spawn with no title (400) before creating a child", { timeout: 20_000 }, async () => {
    const parentId = await createOpsParent();
    github.setRepoWriteAccess(true);

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "Fix the container recreate loop", shipitSource: true },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/title is required/i);

    const children = await app.inject({ method: "GET", url: `/api/sessions/${parentId}/children` });
    expect((children.json().children as unknown[]).length).toBe(0);
  });

  it("emits a session_spawned event carrying the Ops fix metadata (source ref, target repo, diagnosis)", { timeout: 20_000 }, async () => {
    const parentId = await createOpsParent();
    github.setRepoWriteAccess(true);
    const parentClient = await TestClient.connect(port, parentId);

    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${parentId}/spawn`,
        payload: { prompt: "Fix the container recreate loop\nmore detail", title: "Fix container recreate loop", shipitSource: true, spawnedByTurn: "turn-1" },
      });
      expect(res.statusCode).toBe(200);

      const spawnedMsg = (await parentClient.receiveType("session_spawned", 5000)) as {
        type: "session_spawned";
        shipitFix?: {
          sourceRef: string;
          sourceExact: boolean;
          refSource?: string;
          targetRepo?: string;
          diagnosis?: string;
        };
      };

      expect(spawnedMsg.shipitFix).toBeDefined();
      expect(spawnedMsg.shipitFix?.sourceRef).toBe(buildSha);
      expect(spawnedMsg.shipitFix?.sourceExact).toBe(true);
      expect(spawnedMsg.shipitFix?.targetRepo).toBe("owner/shipit");
      expect(spawnedMsg.shipitFix?.diagnosis).toBe("Fix the container recreate loop");
    } finally {
      parentClient.close();
    }
  });

  it("refuses to spawn when the operator lacks write access (403)", { timeout: 20_000 }, async () => {
    const parentId = await createOpsParent();
    github.setRepoWriteAccess(false);

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "Fix the bug", title: "Fix the bug", shipitSource: true },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/report_shipit_bug/i);

    const children = await app.inject({ method: "GET", url: `/api/sessions/${parentId}/children` });
    expect((children.json().children as unknown[]).length).toBe(0);
  });

  it("refuses --shipit-source from a non-ops parent (403)", { timeout: 20_000 }, async () => {
    const res0 = await app.inject({ method: "POST", url: "/api/_test/sessions", payload: { title: "Normal" } });
    const { sessionId: normalParent } = res0.json() as { sessionId: string };
    github.setRepoWriteAccess(true);

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${normalParent}/spawn`,
      payload: { prompt: "Fix the bug", shipitSource: true },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/only available in Ops sessions/i);
  });
});
