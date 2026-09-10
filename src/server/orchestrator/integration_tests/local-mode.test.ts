import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import { initGlobalGitConfig, setGitIdentity } from "../git-config.js";

import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";

describe("Integration: RUNTIME_MODE=local", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let chatHistoryManager: ChatHistoryManager;
  let lastClaude: FakeClaudeProcess = null as any;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-local-mode-"));

    sessionManager = new SessionManager(dbManager);
    chatHistoryManager = new ChatHistoryManager(dbManager);

    initGlobalGitConfig(path.join(tmpDir, "credentials"));
    setGitIdentity("Test User", "test@example.com");

    app = await buildApp({
      runtimeMode: "local",
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      chatHistoryManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => {
        lastClaude = new FakeClaudeProcess();
        return lastClaude as any;
      },
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
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("/api/bootstrap reports runtimeMode: local", async () => {
    const res = await app.inject({ method: "GET", url: "/api/bootstrap" });
    expect(res.statusCode).toBe(200);
    expect(res.json().runtimeMode).toBe("local");
  });

  it("runs a turn end-to-end through the in-process SessionRunner", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Make a file" });
    await waitForClaude(() => lastClaude);
    expect(lastClaude.lastPrompt).toBe("Make a file");

    lastClaude.emit("event", { type: "system", subtype: "init", session_id: "local-session" });
    const sessionMsg = await client.receiveType("session_started");
    const sessionDir = (sessionMsg as any).session.workspaceDir;
    expect(sessionDir).toBeTruthy();

    fs.writeFileSync(path.join(sessionDir, "made-in-local-mode.txt"), "hello");

    lastClaude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "Created the file" }] },
    });
    lastClaude.emit("event", { type: "result", subtype: "success", session_id: "local-session" });
    lastClaude.emit("done", 0);

    const committed = await client.receiveType("git_committed");
    expect((committed as any).message).toBe("Created the file");
    expect((committed as any).hash).toBeTruthy();

    client.close();
  });
});
