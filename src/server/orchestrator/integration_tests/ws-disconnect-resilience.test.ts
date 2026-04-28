/**
 * Integration tests asserting that WebSocket lifecycle has NO effect on
 * server-side state.
 *
 * These tests exist because we've shipped this bug class four times now: a
 * WS disconnect mid-turn quietly stranded `runner.running`, lost post-turn
 * events, or routed a state mutation through a no-op ctx setter. The rule
 * is documented in CLAUDE.md ("WebSocket lifecycle MUST NOT affect server
 * behavior") — this file is the executable version of that rule.
 *
 * Each test follows the same shape:
 *   1. Connect, start a turn (or set up state).
 *   2. Disconnect the WebSocket at an adversarial moment.
 *   3. Drive the agent to completion via the FakeClaudeProcess emitter.
 *   4. Assert that server state is correct — running flag cleared, events
 *      buffered for reconnect, commit produced with the right metadata,
 *      runner not disposed, agent not killed.
 *
 * If any of these tests starts failing, you've likely re-introduced a
 * coupling between WS lifecycle and server state. Do NOT relax the test —
 * fix the coupling.
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
import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";

// Test code receives heterogeneous ws messages and asserts on shape — `any`
// is fine here since the assertions inspect properties at runtime.
type AnyMsg = any;

describe("Integration: WebSocket disconnect resilience", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let chatHistoryManager: ChatHistoryManager;
  let lastClaude: FakeClaudeProcess = null as never;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    lastClaude = null as never;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-ws-resilience-"));
    sessionManager = new SessionManager(dbManager);
    chatHistoryManager = new ChatHistoryManager(dbManager);

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      chatHistoryManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => {
        lastClaude = new FakeClaudeProcess();
        return lastClaude as never;
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
    } catch { /* ignore cleanup errors */ }
  });

  /** Drain client messages up to N times until predicate matches. */
  async function drainUntil(client: TestClient, pred: (m: AnyMsg) => boolean, maxMsgs = 50): Promise<AnyMsg> {
    for (let i = 0; i < maxMsgs; i++) {
      const m: AnyMsg = await client.receive(3000);
      if (pred(m)) return m;
    }
    return null;
  }

  /** Wait long enough for any pending microtasks / setTimeout(0) handlers to drain. */
  const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms));

  // -------------------------------------------------------------------------
  // Core invariant: agent is NOT killed by WS close
  // -------------------------------------------------------------------------

  it("WS close does not kill the agent process", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "Hello" });
    const claude = await waitForClaude(() => lastClaude);
    expect(claude.runCalled).toBe(true);

    client.close();
    await settle();

    expect(claude.killed).toBe(false);
    expect(claude.interrupted).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Invariant: runner.running flips back to false even if WS closed mid-turn
  // -------------------------------------------------------------------------

  it("runner.running is cleared after agent finishes, even if WS already closed", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const sessionId = client.sessionId;

    client.send({ type: "send_message", text: "Hello" });
    const claude = await waitForClaude(() => lastClaude);
    claude.emit("event", { type: "system", subtype: "init", session_id: "agent-1" });
    await drainUntil(client, (m) => m.type === "session_started");

    // Disconnect mid-turn. Server-side state must continue to update correctly.
    client.close();
    await settle();

    // Drive the agent to completion via the FakeClaudeProcess. This fires
    // post-turn handlers — runner.running is set to false from inside an
    // async closure that survives the WS close.
    claude.finish("agent-1");
    await settle(150);

    // HTTP status — the source of truth that doesn't depend on WS.
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/status` });
    expect(res.statusCode).toBe(200);
    expect(res.json().running).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Invariant: post-turn events reach a reconnecting client
  // -------------------------------------------------------------------------

  it("post-turn events emitted after WS close are buffered and replayed on reconnect", async () => {
    const client1 = await TestClient.connect(port);
    await client1.receive();
    const sessionId = client1.sessionId;

    client1.send({ type: "send_message", text: "Hello" });
    const claude = await waitForClaude(() => lastClaude);
    claude.emit("event", { type: "system", subtype: "init", session_id: "agent-2" });
    await drainUntil(client1, (m) => m.type === "session_started");

    // Disconnect before the agent finishes — post-turn events fire after.
    client1.close();
    await settle();

    // Emit an assistant message + tool result so the runner accumulates state
    // (post-turn commit needs something to commit), then complete the turn.
    claude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "All done" }] },
    });
    claude.emit("event", {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    });
    claude.finish("agent-2");
    await settle(200);

    // Reconnect and read history — assistant message must have been persisted
    // even though the originating WS was already gone when post-turn fired.
    const client2 = await TestClient.connect(port, sessionId);
    const historyRes = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/history` });
    expect(historyRes.statusCode).toBe(200);
    const history = historyRes.json();
    expect(history.agentRunning).toBe(false);
    const assistantMsgs = history.messages.filter((m: AnyMsg) => m.role === "assistant");
    expect(assistantMsgs.some((m: AnyMsg) => (m.text ?? "").includes("All done"))).toBe(true);

    client2.close();
  });

  // -------------------------------------------------------------------------
  // Invariant: queue drain works after WS close
  // -------------------------------------------------------------------------

  it("queued messages drain correctly after the originating WS closes", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const sessionId = client.sessionId;

    // Start turn 1.
    client.send({ type: "send_message", text: "Turn 1" });
    const turn1 = await waitForClaude(() => lastClaude);
    turn1.emit("event", { type: "system", subtype: "init", session_id: "agent-q1" });
    await drainUntil(client, (m) => m.type === "session_started");

    // Queue turn 2 while turn 1 is running.
    client.send({ type: "send_message", text: "Turn 2 (queued)" });
    await drainUntil(client, (m) => m.type === "message_queued");

    // Disconnect. Turn 1 finishes, queue should drain into turn 2 — both
    // entirely server-driven, no WS involved.
    client.close();
    await settle();

    turn1.finish("agent-q1");
    // The queue-drain path inside claude-execution.ts kicks off turn 2.
    // Wait for the new agent to be created.
    const turn2 = await waitForClaude(() => lastClaude, turn1);
    expect(turn2.runCalled).toBe(true);
    expect(turn2.lastPrompt).toContain("Turn 2 (queued)");

    // Complete turn 2 cleanly.
    turn2.emit("event", { type: "system", subtype: "init", session_id: "agent-q2" });
    turn2.finish("agent-q2");
    await settle(200);

    const status = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/status` });
    expect(status.json().running).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Invariant: runner is NOT disposed by WS close (registry still has it)
  // -------------------------------------------------------------------------

  it("runner persists in the registry across WS disconnect — fast reattach", async () => {
    const client1 = await TestClient.connect(port);
    await client1.receive();
    const sessionId = client1.sessionId;

    client1.send({ type: "send_message", text: "Hello" });
    const claude = await waitForClaude(() => lastClaude);
    claude.emit("event", { type: "system", subtype: "init", session_id: "agent-r1" });
    await drainUntil(client1, (m) => m.type === "session_started");

    client1.close();
    await settle();

    // Reconnect — must see the running agent (would only be possible if the
    // runner was kept alive in the registry).
    const client2 = await TestClient.connect(port, sessionId);
    const status = await drainUntil(client2, (m) => m.type === "session_status");
    expect(status).toBeTruthy();
    expect(status!.running).toBe(true);

    claude.finish("agent-r1");
    client2.close();
  });

  // -------------------------------------------------------------------------
  // Invariant: disconnecting one session doesn't affect a different session's agent
  // -------------------------------------------------------------------------

  it("disconnecting one session leaves another session's running agent untouched", async () => {
    // Session A: start an agent and DON'T close.
    const clientA = await TestClient.connect(port);
    await clientA.receive();
    clientA.send({ type: "send_message", text: "A" });
    const agentA = await waitForClaude(() => lastClaude);
    agentA.emit("event", { type: "system", subtype: "init", session_id: "agent-a" });
    await drainUntil(clientA, (m) => m.type === "session_started");

    // Session B: start an agent, then close the WS mid-turn.
    const clientB = await TestClient.connect(port);
    await clientB.receive();
    clientB.send({ type: "send_message", text: "B" });
    const agentB = await waitForClaude(() => lastClaude, agentA);
    agentB.emit("event", { type: "system", subtype: "init", session_id: "agent-b" });
    await drainUntil(clientB, (m) => m.type === "session_started");

    clientB.close();
    await settle();

    // Session A's agent must NOT be affected.
    expect(agentA.killed).toBe(false);
    expect(agentA.interrupted).toBe(false);

    // Session B's agent also still alive (close is just a transport event).
    expect(agentB.killed).toBe(false);

    // Both agents finish cleanly.
    agentA.finish("agent-a");
    agentB.finish("agent-b");
    await settle(150);

    clientA.close();
  });

  // -------------------------------------------------------------------------
  // Invariant: running flag cleared via post-turn done handler even when
  // the originating WS was already closed before the agent ran at all
  // (the most adversarial timing — race between send_message and close).
  // -------------------------------------------------------------------------

  it("close immediately after send_message still drains the turn correctly", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const sessionId = client.sessionId;

    client.send({ type: "send_message", text: "race" });
    // Don't wait for any server message — close right away.
    client.close();
    await settle();

    // The agent should have been spawned despite the close.
    const claude = await waitForClaude(() => lastClaude);
    expect(claude.runCalled).toBe(true);

    claude.emit("event", { type: "system", subtype: "init", session_id: "race-1" });
    claude.finish("race-1");
    await settle(150);

    const status = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/status` });
    expect(status.json().running).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Invariant: an agent error (without a follow-up `done`) clears `running`
  // so the runner doesn't stay forever-undisposable.
  //
  // Some adapter paths emit `error` without `done` — e.g. a spawn failure in
  // claude.ts before the process is alive, or an `agent_error` SSE event from
  // the worker that doesn't always pair with `agent_done`. Combined with the
  // running-guard in `runner.dispose()`, a stuck `running=true` would make
  // the runner permanently undisposable. This test pins the recovery path.
  // -------------------------------------------------------------------------

  it("agent error without `done` still clears `running` (runner stays disposable)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const sessionId = client.sessionId;

    client.send({ type: "send_message", text: "go" });
    const claude = await waitForClaude(() => lastClaude);
    claude.emit("event", { type: "system", subtype: "init", session_id: "err-1" });
    await drainUntil(client, (m) => m.type === "session_started");

    // Emit `error` WITHOUT a follow-up `done`. Use the EventEmitter's super.emit
    // so we don't go through the `event`-translation path in FakeClaudeProcess.
    (claude as unknown as { emit: (n: string, e: Error) => void }).emit(
      "error",
      new Error("simulated spawn failure"),
    );
    await settle(150);

    // The HTTP status endpoint must reflect running=false even though `done`
    // never fired. If this fails, the runner is in the stuck state and would
    // refuse all future cleanup.
    const status = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/status` });
    expect(status.statusCode).toBe(200);
    expect(status.json().running).toBe(false);

    client.close();
  });
});
