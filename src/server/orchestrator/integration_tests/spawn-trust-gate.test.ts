/**
 * docs/243 — a spawn whose target repository is not trusted is refused before the
 * child exists, and a spawn that fails after the child exists removes it.
 *
 * The incident this pins: the refusal came from the child's first dispatch, so each
 * "failed" `shipit session create` left a titled child, a branch and a container.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Prevent naming from launching a real agent CLI.
vi.mock("../session-namer.js", () => ({
  generateSessionName: vi.fn().mockResolvedValue({ name: null }),
}));

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  seedRepoCacheWithLocalBare,
} from "./test-helpers.js";

const REPO_URL = "https://github.com/owner/untrusted-spawn-test.git";

describe("Integration: spawn trust gate (docs/243)", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let repoStore: RepoStore;
  let dbManager: DatabaseManager;
  let origGitTerminalPrompt: string | undefined;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-spawn-trust-"));
    origGitTerminalPrompt = process.env.GIT_TERMINAL_PROMPT;
    process.env.GIT_TERMINAL_PROMPT = "0";

    sessionManager = new SessionManager(dbManager);
    repoStore = new RepoStore(dbManager);
    const credentialStore = createTestCredentialStore(tmpDir);

    seedRepoCacheWithLocalBare({
      tmpDir,
      repoUrl: REPO_URL,
      seedFiles: { "README.md": "# untrusted-spawn-test\n" },
    });
    // Registered and cloned, but never trusted: the state of the incident's target.
    repoStore.add(REPO_URL);
    repoStore.setReady(REPO_URL);

    app = await buildApp({
      credentialStore,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      repoStore,
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
    vi.restoreAllMocks();
    await app.close();
    dbManager.close();
    if (origGitTerminalPrompt === undefined) delete process.env.GIT_TERMINAL_PROMPT;
    else process.env.GIT_TERMINAL_PROMPT = origGitTerminalPrompt;
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // ignore cleanup errors
    }
  });

  async function createParent(): Promise<string> {
    const res = await app.inject({ method: "POST", url: "/api/_test/sessions", payload: { title: "Parent" } });
    expect(res.statusCode).toBe(200);
    const { sessionId } = res.json() as { sessionId: string };
    sessionManager.setRemoteUrl(sessionId, REPO_URL);
    return sessionId;
  }

  const spawn = (parentId: string, extra: Record<string, unknown> = {}) =>
    app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "Fix the thing", title: "Fix the thing", spawnedByTurn: "turn-1", ...extra },
    });

  // Every claim ends in markStarted, so its argument is the session a spawn created.
  function claimedSessionIds(): string[] {
    return vi.mocked(sessionManager.markStarted).mock.calls.map(([id]) => id);
  }

  function expectNoTraceOf(sessionId: string): void {
    expect(sessionManager.get(sessionId)).toBeUndefined();
    expect(app.runnerRegistry.get(sessionId)).toBeUndefined();
    expect(fs.existsSync(path.join(tmpDir, "sessions", sessionId, "workspace"))).toBe(false);
  }

  it("refuses with 403 repository_untrusted and names the repository and the Trust action", { timeout: 20_000 }, async () => {
    const parentId = await createParent();

    const res = await spawn(parentId);

    expect(res.statusCode).toBe(403);
    const body = res.json() as { error: string; code?: string };
    expect(body.code).toBe("repository_untrusted");
    expect(body.error).toContain("owner/untrusted-spawn-test");
    expect(body.error).toContain("Trust this repository");
    expect(body.error).not.toMatch(/^Failed to spawn child session/);
  });

  it("creates no session, branch or runner for the refused spawn", { timeout: 20_000 }, async () => {
    const parentId = await createParent();
    vi.spyOn(sessionManager, "markStarted");

    expect((await spawn(parentId)).statusCode).toBe(403);

    expect(claimedSessionIds()).toEqual([]);
    expect(sessionManager.findChildren(parentId)).toEqual([]);
    const graduated = sessionManager.listAllIncludingWarm().filter((s) => s.id !== parentId && !s.warm);
    expect(graduated).toEqual([]);
    expect(app.runnerRegistry.ids().filter((id) => id !== parentId && !sessionManager.get(id)?.warm)).toEqual([]);
  });

  it("reports the refusal on the parent as a spawn-failed card, and no spawned card", { timeout: 20_000 }, async () => {
    const parentId = await createParent();
    const parentClient = await TestClient.connect(port, parentId);
    try {
      // The card needs the parent's runner, which the socket's attach registers.
      await parentClient.receive();

      expect((await spawn(parentId)).statusCode).toBe(403);

      // Every message up to the failure card and after it: receiveType would discard a
      // spawned card that arrived first.
      const messages = await parentClient.collectUntil((m) => m.type === "session_spawn_failed");
      const failed = messages.find((m) => m.type === "session_spawn_failed") as
        | { statusCode: number; message: string }
        | undefined;
      expect(failed?.statusCode).toBe(403);
      expect(failed?.message).toContain("owner/untrusted-spawn-test");
      expect(messages.some((m) => m.type === "session_spawned")).toBe(false);

      const history = app.chatHistoryManager.load(parentId);
      expect(history.filter((m) => m.spawnFailed)).toHaveLength(1);
      expect(history.some((m) => m.spawnedSession)).toBe(false);
    } finally {
      parentClient.close();
    }
  });

  it("lets the same command through once the repository is trusted", { timeout: 20_000 }, async () => {
    const parentId = await createParent();
    const retried = { idempotencyKey: "same-command" };

    expect((await spawn(parentId, retried)).statusCode).toBe(403);
    expect((await spawn(parentId, retried)).statusCode).toBe(403);
    expect(sessionManager.findChildren(parentId)).toEqual([]);

    repoStore.setTrusted(REPO_URL, true);
    const res = await spawn(parentId, retried);

    expect(res.statusCode).toBe(200);
    expect((res.json() as { deduplicated?: boolean }).deduplicated).toBeUndefined();
    expect(sessionManager.findChildren(parentId)).toHaveLength(1);
  });

  it("removes the child when its first dispatch is refused after it was created", { timeout: 20_000 }, async () => {
    const parentId = await createParent();
    vi.spyOn(sessionManager, "markStarted");
    // Trusted for the check before the claim, untrusted by the time the child dispatches.
    vi.spyOn(repoStore, "isTrusted").mockImplementation(
      () => sessionManager.findChildren(parentId).length === 0,
    );

    const res = await spawn(parentId);

    expect(res.statusCode).toBe(403);
    expect((res.json() as { code?: string }).code).toBe("repository_untrusted");
    const [childId] = claimedSessionIds();
    expect(childId).toBeDefined();
    expectNoTraceOf(childId);
    expect(sessionManager.findChildren(parentId)).toEqual([]);
  });
});
