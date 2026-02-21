import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../auth.js";
import { GitHubAuthManager } from "../github-auth.js";
import { PreviewManager } from "../preview-manager.js";
import { ClaudeProcess } from "../claude.js";
import { FileWatcher } from "../file-watcher.js";
import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubPreviewManager,
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  StubFileWatcher,
  waitForClaude,
  createTestCredentialStore,
} from "./test-helpers.js";
import { getContextWindowSize } from "../index.js";

describe("Integration: Model context & token tracking", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let lastClaude: FakeClaudeProcess = null as any;

  beforeEach(async () => {
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-model-context-"));

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: new SessionManager(path.join(tmpDir, "sessions.json")),
      previewManager: new StubPreviewManager() as unknown as PreviewManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      claudeFactory: () => {
        lastClaude = new FakeClaudeProcess();
        return lastClaude as unknown as ClaudeProcess;
      },
      fileWatcher: new StubFileWatcher() as unknown as FileWatcher,
      workspaceDir: tmpDir,
      serveStatic: false,
      startPreview: false,
      portScanIntervalMs: 0,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const match = address.match(/:(\d+)$/);
    port = match ? Number(match[1]) : 0;
  });

  afterEach(async () => {
    await app.close();
    // Wait for any pending async operations (git auto-commit) to complete
    await new Promise((r) => setTimeout(r, 200));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // Ignore cleanup errors — CI tmpdir will be cleared anyway
    }
  });

  it("model_info is sent when Claude init event includes model", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Start a Claude turn
    client.send({ type: "send_message", text: "hello" });
    await waitForClaude(() => lastClaude);

    // Simulate system init with model field
    lastClaude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "model-info-session",
      model: "claude-sonnet-4-20250514",
    });

    // Drain claude_event for system init
    await client.receiveSkipLogs(); // claude_event
    // session_started
    await client.receiveSkipLogs(); // session_started

    // Next message should be model_info
    const modelInfo = await client.receiveSkipLogs();
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
    await client.receive(); // preview_status

    // Start a Claude turn
    client.send({ type: "send_message", text: "hello" });
    await waitForClaude(() => lastClaude);

    // Simulate system init WITHOUT model field
    lastClaude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "no-model-session",
    });

    // Emit result + done to finish the turn
    lastClaude.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "no-model-session",
    });
    lastClaude.emit("done", 0);

    await new Promise((r) => setTimeout(r, 200));

    // Drain all messages and verify none have type model_info
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
    await client.receive(); // preview_status

    // Start a Claude turn
    client.send({ type: "send_message", text: "hello" });
    await waitForClaude(() => lastClaude);

    // Simulate system init
    lastClaude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "token-session",
    });

    // Drain events (claude_event for system init, session_started)
    await client.receiveSkipLogs(); // claude_event
    await client.receiveSkipLogs(); // session_started

    // Simulate assistant text
    lastClaude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "Here is my response" }] },
    });
    await client.receiveSkipLogs(); // claude_event for assistant

    // Simulate result with token data
    lastClaude.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "token-session",
      total_cost_usd: 0.05,
      duration_ms: 1500,
      input_tokens: 5000,
      output_tokens: 1200,
    });

    // Drain the claude_event for result
    const resultEvent = await client.receiveSkipLogs();
    expect(resultEvent.type).toBe("claude_event");

    // Next should be usage_update with token data
    const usageUpdate = await client.receiveSkipLogs();
    expect(usageUpdate).toMatchObject({
      type: "usage_update",
      lastTurnInputTokens: 5000,
      lastTurnOutputTokens: 1200,
      cumulativeInputTokens: 5000,
    });

    lastClaude.emit("done", 0);
    client.close();
  });

  it("context window lookup returns correct size for various models", () => {
    // Opus model
    expect(getContextWindowSize("claude-opus-4-20250514")).toBe(200000);

    // Sonnet model
    expect(getContextWindowSize("claude-sonnet-4-20250514")).toBe(200000);

    // Haiku model
    expect(getContextWindowSize("claude-haiku-3-5-20241022")).toBe(200000);

    // Unknown model — should still return a default
    expect(getContextWindowSize("unknown-model-xyz")).toBe(200000);
  });
});
