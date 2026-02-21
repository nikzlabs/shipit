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

describe("Integration: Usage & cost tracking", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let lastClaude: FakeClaudeProcess = null as any;

  beforeEach(async () => {
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-usage-integration-"));

    sessionManager = new SessionManager(path.join(tmpDir, "sessions.json"));

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
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

  it("get_usage_stats returns empty stats initially", async () => {
    // Create a tracked session for the HTTP endpoint
    const sid = "usage-empty-test";
    const sdir = path.join(tmpDir, "sessions", sid);
    fs.mkdirSync(sdir, { recursive: true });
    sessionManager.track(sid, "Test", sdir);

    const res = await app.inject({ method: "GET", url: `/api/sessions/${sid}/usage` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      stats: {
        sessions: [],
        totalCostUsd: 0,
        totalTurns: 0,
      },
    });
  });

  it("usage_update is sent after result event with total_cost_usd", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Start a Claude turn
    client.send({ type: "send_message", text: "hello" });
    await waitForClaude(() => lastClaude);

    // Simulate system init
    lastClaude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "usage-session-1",
    });

    // Drain events (claude_event for system init, session_started)
    await client.receiveSkipLogs(); // claude_event
    const sessionStarted = await client.receiveSkipLogs(); // session_started
    const appSessionId = (sessionStarted as any).session.id;

    // Simulate assistant text
    lastClaude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "Hi there" }] },
    });
    await client.receiveSkipLogs(); // claude_event for assistant

    // Simulate result with cost
    lastClaude.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "usage-session-1",
      total_cost_usd: 0.42,
      duration_ms: 3200,
    });

    // We should get the claude_event for result AND the usage_update
    const resultEvent = await client.receiveSkipLogs();
    expect(resultEvent.type).toBe("claude_event");

    const usageUpdate = await client.receiveSkipLogs();
    expect(usageUpdate).toMatchObject({
      type: "usage_update",
      sessionId: appSessionId,
      totalCostUsd: 0.42,
      totalDurationMs: 3200,
      turnCount: 1,
    });

    // Emit done to finish the turn
    lastClaude.emit("done", 0);

    client.close();
  });

  it("usage_update accumulates across multiple turns", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // --- Turn 1 ---
    client.send({ type: "send_message", text: "turn 1" });
    await waitForClaude(() => lastClaude);
    lastClaude.emit("event", { type: "system", subtype: "init", session_id: "accum-session" });
    await client.receiveSkipLogs(); // claude_event
    const sessionStarted = await client.receiveSkipLogs(); // session_started
    const appSessionId = (sessionStarted as any).session.id;

    lastClaude.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "accum-session",
      total_cost_usd: 0.10,
      duration_ms: 1000,
    });
    await client.receiveSkipLogs(); // claude_event
    const update1 = await client.receiveSkipLogs();
    expect(update1).toMatchObject({
      type: "usage_update",
      turnCount: 1,
      totalCostUsd: 0.10,
    });
    lastClaude.emit("done", 0);

    // Wait for done handler
    await new Promise((r) => setTimeout(r, 100));

    // --- Turn 2: resume with the app session UUID ---
    const prevClaude = lastClaude;
    client.send({ type: "send_message", text: "turn 2", sessionId: appSessionId });
    await waitForClaude(() => lastClaude, prevClaude);
    lastClaude.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "accum-session",
      total_cost_usd: 0.20,
      duration_ms: 2000,
    });

    // Find the usage_update among possible messages
    let update2: any = null;
    for (let i = 0; i < 10; i++) {
      const msg = await client.receive();
      if (msg.type === "usage_update") {
        update2 = msg;
        break;
      }
    }

    expect(update2).toBeDefined();
    expect(update2.type).toBe("usage_update");
    expect(update2.turnCount).toBe(2);
    expect(update2.totalCostUsd).toBeCloseTo(0.30);
    expect(update2.totalDurationMs).toBe(3000);

    lastClaude.emit("done", 0);
    client.close();
  });

  it("get_usage_stats returns recorded data", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Record some usage by running a turn
    client.send({ type: "send_message", text: "test" });
    await waitForClaude(() => lastClaude);
    lastClaude.emit("event", { type: "system", subtype: "init", session_id: "stats-session" });
    await client.receiveSkipLogs(); // claude_event
    const sessionStarted = await client.receiveSkipLogs(); // session_started
    const appSessionId = (sessionStarted as any).session.id;

    lastClaude.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "stats-session",
      total_cost_usd: 0.55,
      duration_ms: 5000,
    });
    await client.receiveSkipLogs(); // claude_event
    await client.receiveSkipLogs(); // usage_update
    lastClaude.emit("done", 0);
    await new Promise((r) => setTimeout(r, 100));

    // Now request full stats via HTTP
    const statsRes = await app.inject({ method: "GET", url: `/api/sessions/${appSessionId}/usage` });
    expect(statsRes.statusCode).toBe(200);
    const statsMsg = statsRes.json();

    expect(statsMsg.stats.totalCostUsd).toBeCloseTo(0.55);
    expect(statsMsg.stats.totalTurns).toBe(1);
    expect(statsMsg.stats.sessions).toHaveLength(1);
    expect(statsMsg.stats.sessions[0]).toMatchObject({
      sessionId: appSessionId,
      totalCostUsd: 0.55,
      totalDurationMs: 5000,
      turnCount: 1,
    });

    client.close();
  });

  it("no usage_update when total_cost_usd is undefined", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "hello" });
    await waitForClaude(() => lastClaude);
    lastClaude.emit("event", { type: "system", subtype: "init", session_id: "no-cost-session" });

    // Result without total_cost_usd
    lastClaude.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "no-cost-session",
    });

    lastClaude.emit("done", 0);
    await new Promise((r) => setTimeout(r, 200));

    // Drain all messages and check none are usage_update
    const allMessages: any[] = [];
    try {
      for (let i = 0; i < 20; i++) {
        allMessages.push(await client.receive(200));
      }
    } catch {
      // timeout is expected when no more messages
    }
    expect(allMessages.every((m: any) => m.type !== "usage_update")).toBe(true);

    client.close();
  });

  it("archive_session preserves usage data", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Record some usage
    client.send({ type: "send_message", text: "test" });
    await waitForClaude(() => lastClaude);
    lastClaude.emit("event", { type: "system", subtype: "init", session_id: "arc-usage-session" });
    await client.receiveSkipLogs(); // claude_event
    const sessionStarted = await client.receiveSkipLogs(); // session_started
    const appSessionId = (sessionStarted as any).session.id;

    lastClaude.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "arc-usage-session",
      total_cost_usd: 0.99,
      duration_ms: 7000,
    });
    await client.receiveSkipLogs(); // claude_event
    await client.receiveSkipLogs(); // usage_update
    lastClaude.emit("done", 0);
    await new Promise((r) => setTimeout(r, 100));

    // Archive the session via HTTP
    const archiveRes = await app.inject({ method: "DELETE", url: `/api/sessions/${appSessionId}` });
    expect(archiveRes.statusCode).toBe(200);

    // Verify usage is still present (archive preserves data) via HTTP
    const statsRes = await app.inject({ method: "GET", url: `/api/sessions/${appSessionId}/usage` });
    expect(statsRes.statusCode).toBe(200);
    expect(statsRes.json().stats.totalTurns).toBe(1);

    client.close();
  });
});
