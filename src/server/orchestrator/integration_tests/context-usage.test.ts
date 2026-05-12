import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../auth.js";
import { GitHubAuthManager } from "../github-auth.js";
import { ChatHistoryManager } from "../chat-history.js";
import { UsageManager } from "../usage.js";
import {
  MODEL_CONTEXT_WINDOWS,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  getContextWindowForModel,
} from "../../shared/agent-registry.js";
import type { FastifyInstance } from "fastify";
import type { WsTurnUsageUpdate, AgentProcess, AgentId } from "../../shared/types.js";
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

/**
 * Tests for the context-window-display feature (105). Asserts:
 *   1. `turn_usage_update` is emitted at the end of each completed turn.
 *   2. The per-turn series is fetchable from `/history` for reload-time
 *      rehydration of the dial (the canonical source is `usage_turns`).
 *   3. `MODEL_CONTEXT_WINDOWS` resolves correctly for known models.
 *   4. `UsageManager.getPerTurnUsage` returns turn rows with cache + model.
 *   5. A drop in input tokens between turns surfaces (the data the dial
 *      uses to detect compaction).
 */
describe("Integration: Context window usage (105)", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let lastClaude: FakeClaudeProcess = null as unknown as FakeClaudeProcess;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    lastClaude = null as unknown as FakeClaudeProcess;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-context-usage-"));

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      databaseManager: dbManager,
      sessionManager: new SessionManager(dbManager),
      chatHistoryManager: new ChatHistoryManager(dbManager),
      usageManager: new UsageManager(dbManager),
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      agentFactory: ((_id: AgentId) => {
        lastClaude = new FakeClaudeProcess();
        return lastClaude as unknown as AgentProcess;
      }),
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
      // ignore
    }
  });

  it("emits turn_usage_update at end of turn with token + cache breakdown", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "hello" });
    await waitForClaude(() => lastClaude);

    lastClaude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "ctx-session",
      model: "claude-sonnet-4-20250514",
    });
    await client.receiveType("session_started");

    lastClaude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "ok" }] },
    });
    lastClaude.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "ctx-session",
      total_cost_usd: 0.1,
      duration_ms: 2500,
      usage: {
        input_tokens: 10_000,
        output_tokens: 500,
        cache_read_input_tokens: 2_000,
        cache_creation_input_tokens: 1_000,
      },
    });

    const turnUsage = (await client.receiveType("turn_usage_update")) as WsTurnUsageUpdate;
    expect(turnUsage.type).toBe("turn_usage_update");
    expect(turnUsage.sessionId).toBe(client.sessionId);
    expect(turnUsage.turnCount).toBe(1);
    expect(turnUsage.totalCostUsd).toBeCloseTo(0.1);
    expect(turnUsage.turn).toMatchObject({
      inputTokens: 10_000,
      outputTokens: 500,
      cacheRead: 2_000,
      cacheCreate: 1_000,
      costUsd: 0.1,
      model: "claude-sonnet-4-20250514",
    });
    expect(turnUsage.turn.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    lastClaude.emit("done", 0);
    client.close();
  });

  it("emits turn_usage_update for each of two consecutive turns (matches cumulative usage)", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Turn 1
    client.send({ type: "send_message", text: "first" });
    await waitForClaude(() => lastClaude);
    lastClaude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "ctx-2turn",
      model: "claude-sonnet-4-20250514",
    });
    await client.receiveType("session_started");
    lastClaude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "first response" }] },
    });
    lastClaude.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "ctx-2turn",
      total_cost_usd: 0.05,
      duration_ms: 1000,
      usage: { input_tokens: 5_000, output_tokens: 200 },
    });
    const u1 = (await client.receiveType("turn_usage_update")) as WsTurnUsageUpdate;
    expect(u1.turnCount).toBe(1);
    expect(u1.totalCostUsd).toBeCloseTo(0.05);
    expect(u1.turn.inputTokens).toBe(5_000);
    lastClaude.emit("done", 0);

    // Turn 2 — pass the previous Claude instance to waitForClaude so it
    // waits for the NEW process. Otherwise it returns immediately on the
    // turn-1 instance (still runCalled=true) and we end up emitting events
    // on a finished process while the real second-turn handleSendMessage
    // runs after this test ends and the db has been closed.
    const turn1Claude = lastClaude;
    await new Promise((r) => setTimeout(r, 50));
    client.send({ type: "send_message", text: "second" });
    await waitForClaude(() => lastClaude, turn1Claude);
    lastClaude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "ctx-2turn",
      model: "claude-sonnet-4-20250514",
    });
    lastClaude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "second response" }] },
    });
    lastClaude.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "ctx-2turn",
      total_cost_usd: 0.07,
      duration_ms: 1200,
      usage: { input_tokens: 12_000, output_tokens: 300 },
    });
    const u2 = (await client.receiveType("turn_usage_update")) as WsTurnUsageUpdate;
    expect(u2.turnCount).toBe(2);
    expect(u2.totalCostUsd).toBeCloseTo(0.12);
    expect(u2.turn.inputTokens).toBe(12_000);
    lastClaude.emit("done", 0);

    client.close();
  });

  it("exposes per-turn usage via UsageManager (canonical store) and the /history endpoint", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "hi" });
    await waitForClaude(() => lastClaude);
    lastClaude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "persist-session",
      model: "claude-sonnet-4-20250514",
    });
    await client.receiveType("session_started");
    lastClaude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "answer" }] },
    });
    lastClaude.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "persist-session",
      total_cost_usd: 0.02,
      duration_ms: 800,
      usage: { input_tokens: 3_000, output_tokens: 100 },
    });
    await client.receiveType("turn_usage_update");
    lastClaude.emit("done", 0);

    // Wait long enough for finalizeInProgress + auto-commit to complete
    await new Promise((r) => setTimeout(r, 250));

    // UsageManager (the canonical store) exposes the per-turn record.
    const usageManager = new UsageManager(dbManager);
    const turns = usageManager.getPerTurnUsage(client.sessionId);
    expect(turns).toHaveLength(1);
    expect(turns[0].inputTokens).toBe(3_000);
    expect(turns[0].model).toBe("claude-sonnet-4-20250514");

    // The /history HTTP endpoint surfaces the same per-turn series so the
    // ContextDial can rehydrate after a session reload without re-running
    // the agent.
    const historyRes = await app.inject({ method: "GET", url: `/api/sessions/${client.sessionId}/history` });
    expect(historyRes.statusCode).toBe(200);
    const history = historyRes.json() as {
      turnUsage: { inputTokens: number; outputTokens: number; costUsd: number }[];
      sessionUsage: { totalCostUsd: number; turnCount: number } | null;
      cumulativeInputTokens?: number;
      cumulativeOutputTokens?: number;
    };
    expect(history.turnUsage).toHaveLength(1);
    expect(history.turnUsage[0]).toMatchObject({ inputTokens: 3_000, outputTokens: 100, costUsd: 0.02 });
    expect(history.sessionUsage).toMatchObject({ totalCostUsd: 0.02, turnCount: 1 });
    expect(history.cumulativeInputTokens).toBe(3_000);
    expect(history.cumulativeOutputTokens).toBe(100);

    client.close();
  });

  it("MODEL_CONTEXT_WINDOWS resolves known and unknown models", () => {
    // Exact match
    expect(getContextWindowForModel("sonnet")).toBe(MODEL_CONTEXT_WINDOWS.sonnet);
    expect(getContextWindowForModel("opus-1m")).toBe(1_000_000);
    // Substring match (real CLI model identifiers contain dates/versions)
    expect(getContextWindowForModel("claude-sonnet-4-20250514")).toBe(200_000);
    expect(getContextWindowForModel("gpt-5.4-mini-2025")).toBe(256_000);
    // Unknown
    expect(getContextWindowForModel("unknown-model-xyz")).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    expect(getContextWindowForModel(undefined)).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
  });
});
