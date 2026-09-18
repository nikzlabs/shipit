import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import { DatabaseManager } from "../../shared/database.js";

import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";

const COMPLETE = {
  agentId: "codex",
  serviceId: "openai",
  billingMode: "sub",
  modelId: "gpt-5.6-sol",
  reasoningEffort: "high",
  prompt: "review this",
  depth: 0,
};

describe("Integration: POST /api/sessions/:id/agent/spawn — the spawn target (docs/261)", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let sessionManager: SessionManager;
  let credentialStore: ReturnType<typeof createTestCredentialStore>;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-spawn-route-"));
    sessionManager = new SessionManager(dbManager);
    credentialStore = createTestCredentialStore(tmpDir);
    app = await buildApp({
      credentialStore,
      credentialsDir: path.join(tmpDir, "credentials"),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      chatHistoryManager: new ChatHistoryManager(dbManager),
      authManager: new StubAuthManager() as unknown as AuthManager,
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
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors
    }
  });

  const post = (payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/sessions/any-session/agent/spawn", payload });

  it("400 — an incomplete explicit call is refused, naming what is missing", async () => {
    const res = await post({ agentId: "codex", modelId: "gpt-5.6-sol", prompt: "review", depth: 0 });
    expect(res.statusCode).toBe(400);
    const error = res.json().error as string;
    expect(error).toContain("--service");
    expect(error).toContain("--billing-mode");
    expect(error).toContain("--effort");
  });

  it("accepts a role combined with a parameter — the override path", async () => {
    const res = await post({ role: "reviewer", agentId: "codex", prompt: "review", depth: 0 });
    expect(res.statusCode).toBe(404);
    expect(res.json().error as string).toMatch(/session not found/i);
  });

  it("does not reject an unknown role name at the edge", async () => {
    const res = await post({ role: "critic", prompt: "review", depth: 0 });
    expect(res.statusCode).toBe(404);
    expect(res.json().error as string).toMatch(/session not found/i);
  });

  it("passes a complete explicit call through to the service's own gates", async () => {
    const res = await post(COMPLETE);
    expect(res.statusCode).toBe(404);
    expect(res.json().error as string).toMatch(/session not found/i);
  });

  it("passes a role through to the service's own gates", async () => {
    const res = await post({ role: "reviewer", prompt: "review this", depth: 0 });
    expect(res.statusCode).toBe(404);
    expect(res.json().error as string).toMatch(/session not found/i);
  });

  describe("against a live, pinned session", () => {
    let client: TestClient;

    beforeEach(async () => {
      credentialStore.setEnableSubAgents(true);
      client = await TestClient.connect(port);
      await client.receive();
      sessionManager.setAgentPinned(client.sessionId);
    });

    afterEach(() => client.close());

    const live = (payload: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: `/api/sessions/${client.sessionId}/agent/spawn`,
        payload,
      });

    it("routes a role to the reviewer resolver", async () => {
      const res = await live({ role: "reviewer", prompt: "review this", depth: 0 });
      expect(res.statusCode).toBe(400);
      expect(res.json().error as string).toMatch(/role "reviewer" cannot run/);
    });

    it("refuses an unknown role at resolution, listing the roles that exist", async () => {
      const res = await live({ role: "critic", prompt: "review this", depth: 0 });
      expect(res.statusCode).toBe(400);
      const error = res.json().error as string;
      expect(error).toContain("critic");
      expect(error).toContain("reviewer");
    });

    it("routes an explicit call to the named harness's own gates", async () => {
      const res = await live(COMPLETE);
      expect(res.statusCode).toBe(400);
      expect(res.json().error as string).toMatch(/Codex is not signed in/);
    });

    it("lists the install's roles, the reviewer included on a bare install", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/sessions/${client.sessionId}/agent/roles`,
      });
      expect(res.statusCode).toBe(200);
      const roles = (res.json() as { roles: { name: string }[] }).roles;
      expect(roles.map((r) => r.name)).toContain("reviewer");
    });

    it("lists the parameters an override may name", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/sessions/${client.sessionId}/agent/params`,
      });
      expect(res.statusCode).toBe(200);
      const harnesses = (res.json() as { harnesses: { id: string; reasoningLevels: string[] }[] })
        .harnesses;
      expect(harnesses.length).toBeGreaterThan(0);
      for (const harness of harnesses) {
        expect(typeof harness.id).toBe("string");
        expect(Array.isArray(harness.reasoningLevels)).toBe(true);
      }
    });
  });

  it("404s both reads for a session that does not exist", async () => {
    for (const path of ["roles", "params"]) {
      const res = await app.inject({ method: "GET", url: `/api/sessions/nope/agent/${path}` });
      expect(res.statusCode).toBe(404);
    }
  });
});
