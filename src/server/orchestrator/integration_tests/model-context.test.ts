import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import { GitHubAuthManager } from "../github-auth.js";


import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";
import { CONTEXT_WINDOW_TOKENS } from "../index.js";

describe("Integration: Model context & token tracking", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let lastClaude: FakeClaudeProcess = null as any;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-model-context-"));

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: new SessionManager(dbManager),
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
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
    await new Promise((r) => setTimeout(r, 200));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // Ignore cleanup errors.
    }
  });

  it("model_info is sent when Claude init event includes model", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "hello" });
    await waitForClaude(() => lastClaude);

    lastClaude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "model-info-session",
      model: "claude-sonnet-4-20250514",
    });

    await client.receiveType("session_started");

    const modelInfo = await client.receiveType("model_info");
    expect(modelInfo).toMatchObject({
      type: "model_info",
      model: "claude-sonnet-4-20250514",
      contextWindowTokens: 200000,
    });

    lastClaude.emit("done", 0);
    client.close();
  });

  it("no model_info when init event lacks model field", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "hello" });
    await waitForClaude(() => lastClaude);

    lastClaude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "no-model-session",
    });

    lastClaude.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "no-model-session",
    });
    lastClaude.emit("done", 0);

    await new Promise((r) => setTimeout(r, 200));

    const allMessages: any[] = [];
    try {
      for (let i = 0; i < 20; i++) {
        allMessages.push(await client.receive(200));
      }
    } catch {
      // timeout is expected when no more messages
    }
    expect(allMessages.every((m: any) => m.type !== "model_info")).toBe(true);

    client.close();
  });

  it("usage_update includes token data when result has tokens", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "hello" });
    await waitForClaude(() => lastClaude);

    lastClaude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "token-session",
    });

    await client.receiveType("session_started");

    lastClaude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "Here is my response" }] },
    });
    lastClaude.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "token-session",
      total_cost_usd: 0.05,
      duration_ms: 1500,
      usage: { input_tokens: 5000, output_tokens: 1200 },
    });

    const resultEvent = await client.receiveType("agent_event");
    expect(resultEvent.type).toBe("agent_event");

    const usageUpdate = await client.receiveType("usage_update");
    expect(usageUpdate).toMatchObject({
      type: "usage_update",
      cumulativeInputTokens: 5000,
      cumulativeOutputTokens: 1200,
    });

    lastClaude.emit("done", 0);
    client.close();
  });

  it("context window constant is 200k tokens", () => {
    expect(CONTEXT_WINDOW_TOKENS).toBe(200000);
  });
});
