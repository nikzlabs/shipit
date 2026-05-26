/**
 * Integration tests for agent registry — list_agents via HTTP bootstrap.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../auth.js";
import { AgentRegistry } from "../../shared/agent-registry.js";
import type { FastifyInstance } from "fastify";
import {
  StubAuthManager,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";

describe("Integration: Agent registry — list_agents", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-agent-registry-"));

    const registry = new AgentRegistry({
      checkBinary: async (binary) => binary === "claude" || binary === "codex",
      checkClaudeAuth: () => true,
    });
    await registry.detect();

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: new SessionManager(dbManager),
      chatHistoryManager: new ChatHistoryManager(dbManager),
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentRegistry: registry,
      workspaceDir: tmpDir,
      serveStatic: false,
    });

    await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("list_agents returns agent availability", async () => {
    const res = await app.inject({ method: "GET", url: "/api/bootstrap" });
    expect(res.statusCode).toBe(200);
    const data = res.json();

    expect(data.agents).toHaveLength(2);

    const claude = data.agents.find((a: any) => a.id === "claude");
    expect(claude.installed).toBe(true);
    expect(claude.authConfigured).toBe(true);

    const codex = data.agents.find((a: any) => a.id === "codex");
    expect(codex.installed).toBe(true);
    // Codex auth depends on OPENAI_API_KEY being set
    expect(codex.name).toBe("Codex");
  });
});
