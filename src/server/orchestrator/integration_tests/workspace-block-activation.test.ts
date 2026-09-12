/**
 * docs/298-broken-workspace-visibility — opening a session is the moment the marker
 * is most useful and was the moment nothing set it: the disk janitor never evaluates
 * a session with an attached viewer, and the per-repo sidebar cap can hide a resolved
 * session that only a `/session/<id>` URL reaches.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";

vi.mock("../templates.js", async (importOriginal) => {
  const mod = await importOriginal() as Record<string, unknown>;
  return { ...mod, generatePackageLock: vi.fn().mockResolvedValue(undefined) };
});
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import type { AuthManager } from "../agents/claude/auth-manager.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import type { DatabaseManager } from "../../shared/database.js";

describe("Integration: activation evaluates the workspace (docs/298)", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-ws-block-"));
    sessionManager = new SessionManager(dbManager);

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      agentFactory: () => new FakeClaudeProcess() as never,
      workspaceDir: tmpDir,
      serveStatic: false,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    port = Number(/:(\d+)$/.exec(address)?.[1] ?? 0);
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* ignore cleanup errors */ }
  });

  async function createSession(): Promise<{ sessionId: string; workspaceDir: string }> {
    const res = await app.inject({
      method: "POST",
      url: "/api/_test/sessions",
      payload: { title: "Broken checkout" },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as { sessionId: string; workspaceDir: string };
  }

  async function waitForBlock(
    sessionId: string,
    expected: string | undefined,
  ): Promise<string | undefined> {
    for (let i = 0; i < 100; i++) {
      const current = sessionManager.get(sessionId)?.workspaceBlock;
      if (current === expected) return current;
      await new Promise((r) => setTimeout(r, 20));
    }
    return sessionManager.get(sessionId)?.workspaceBlock;
  }

  it("marks a checkout stuck mid-rebase when the user opens the session", async () => {
    const { sessionId, workspaceDir } = await createSession();
    // The incident's shape: git stopped part-way through a rebase and stayed there.
    fs.mkdirSync(path.join(workspaceDir, ".git", "rebase-merge"), { recursive: true });

    const client = await TestClient.connect(port, sessionId);
    try {
      expect(await waitForBlock(sessionId, "conflict")).toBe("conflict");
    } finally {
      client.close();
    }
  });

  it("withdraws the marker when the repaired session is opened again", async () => {
    const { sessionId, workspaceDir } = await createSession();
    fs.mkdirSync(path.join(workspaceDir, ".git", "rebase-merge"), { recursive: true });

    const first = await TestClient.connect(port, sessionId);
    expect(await waitForBlock(sessionId, "conflict")).toBe("conflict");
    first.close();

    fs.rmSync(path.join(workspaceDir, ".git", "rebase-merge"), { recursive: true, force: true });

    const second = await TestClient.connect(port, sessionId);
    try {
      expect(await waitForBlock(sessionId, undefined)).toBeUndefined();
    } finally {
      second.close();
    }
  });

  it("leaves a healthy checkout unmarked", async () => {
    const { sessionId } = await createSession();

    const client = await TestClient.connect(port, sessionId);
    try {
      expect(await waitForBlock(sessionId, undefined)).toBeUndefined();
    } finally {
      client.close();
    }
  });
});
