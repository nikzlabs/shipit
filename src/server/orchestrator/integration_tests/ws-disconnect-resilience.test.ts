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
import { AuthManager } from "../agents/claude/auth-manager.js";
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

  it("unpersisted streaming events emitted after WS close are replayed on reconnect", async () => {
    const client1 = await TestClient.connect(port);
    await client1.receive();
    const sessionId = client1.sessionId;

    client1.send({ type: "send_message", text: "stream while hidden" });
    const claude = await waitForClaude(() => lastClaude);
    claude.initSession("agent-replay-1");
    await drainUntil(client1, (m) => m.type === "session_started");

    client1.close();
    await settle(50);

    claude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "background chunk" }] },
    });
    await settle(50);

    const client2 = await TestClient.connect(port, sessionId);
    const replayed = await drainUntil(
      client2,
      (m) =>
        m.type === "agent_event"
        && m.event?.type === "agent_assistant"
        && m.event.content?.some((b: AnyMsg) => b.type === "text" && b.text === "background chunk"),
    );

    expect(replayed).toBeTruthy();
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
    // The queue-drain path inside agent-execution.ts kicks off turn 2.
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

  // -------------------------------------------------------------------------
  // Invariant: a turn that ends via the ERROR path must NOT be replayed to a
  // reconnecting viewer (docs/163 — duplicate-turn-on-reconnect regression).
  //
  // Production trigger: a deploy/restart kills the agent container mid- or
  // just-post-turn. The proxy emits `error`; the error handler finalizes the
  // partial turn into chat history. Before the fix, the turn-event replay
  // buffer was left populated (lastPersistedBufferIndex only advances on
  // tool-result / agent_result boundaries, never on the error path), so every
  // subsequent WS reconnect — including a browser reload — replayed the
  // already-persisted turn a second time, producing a duplicate that survives
  // reload. The fix clears the buffer on the error path, mirroring
  // agent_result.
  // -------------------------------------------------------------------------

  it("an errored turn is not replayed on reconnect (no duplicate)", async () => {
    const client1 = await TestClient.connect(port);
    await client1.receive();
    const sessionId = client1.sessionId;

    client1.send({ type: "send_message", text: "go" });
    const claude = await waitForClaude(() => lastClaude);
    claude.emit("event", { type: "system", subtype: "init", session_id: "dup-err-1" });
    await drainUntil(client1, (m) => m.type === "session_started");

    // The agent streams an assistant message (no tool_result, so
    // lastPersistedBufferIndex never advances), then the process errors —
    // exactly the deploy/container-kill shape.
    claude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "REPLAY_CANARY answer" }] },
    });
    await settle(50);
    (claude as unknown as { emit: (n: string, e: Error) => void }).emit(
      "error",
      new Error("container killed mid-turn"),
    );
    await settle(150);

    // Server-side proof: the replay buffer must not retain the turn's agent
    // content after the terminal error. The buffer holds at most the trailing
    // `session_status` (running=false) emitted after the clear — the same
    // harmless tail the clean `agent_result` path leaves. Before the fix the
    // buffer still carried the assistant `agent_event`, so the count was
    // higher and that content got re-emitted on reconnect.
    const state = await app.inject({ method: "GET", url: `/api/_test/runner/${sessionId}` });
    expect(state.statusCode).toBe(200);
    expect(state.json().turnEventBufferSize).toBeLessThanOrEqual(1);

    // Drop the WS and reconnect (the browser-reload path). The reconnecting
    // client must NOT receive the assistant event a second time — it already
    // has the finalized turn from HTTP history.
    client1.close();
    await settle();
    const client2 = await TestClient.connect(port, sessionId);
    const replayed = (await client2.drain({ quietMs: 200, maxMs: 1500 })).filter(
      (m: AnyMsg) =>
        m.type === "agent_event"
        && m.event?.type === "agent_assistant"
        && m.event.content?.some((b: AnyMsg) => b.type === "text" && b.text === "REPLAY_CANARY answer"),
    );
    expect(replayed).toHaveLength(0);

    // And the turn appears exactly once in stored history.
    const historyRes = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/history` });
    const occurrences = historyRes.json().messages.filter(
      (m: AnyMsg) => (m.text ?? "").includes("REPLAY_CANARY answer"),
    );
    expect(occurrences).toHaveLength(1);

    client2.close();
  });

  // -------------------------------------------------------------------------
  // Invariant: a turn ended via user INTERRUPT must NOT be replayed on
  // reconnect either (docs/163). Same root cause as the error path: the
  // interrupt finalizes the partial turn into history but the older code left
  // the replay buffer dirty.
  // -------------------------------------------------------------------------

  it("an interrupted turn is not replayed on reconnect (no duplicate)", async () => {
    const client1 = await TestClient.connect(port);
    await client1.receive();
    const sessionId = client1.sessionId;

    client1.send({ type: "send_message", text: "go" });
    const claude = await waitForClaude(() => lastClaude);
    claude.emit("event", { type: "system", subtype: "init", session_id: "dup-int-1" });
    await drainUntil(client1, (m) => m.type === "session_started");

    claude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "INTERRUPT_CANARY partial" }] },
    });
    await settle(50);

    // User interrupts — FakeClaudeProcess.interrupt() emits `done` (code 1)
    // with no `result` event, driving the onInterruptedTurn path.
    client1.send({ type: "interrupt_agent" });
    await settle(150);

    const state = await app.inject({ method: "GET", url: `/api/_test/runner/${sessionId}` });
    expect(state.statusCode).toBe(200);
    // Buffer retains at most the trailing post-turn status, never the
    // interrupted turn's assistant content (see the error-path test above).
    expect(state.json().turnEventBufferSize).toBeLessThanOrEqual(1);

    client1.close();
    await settle();
    const client2 = await TestClient.connect(port, sessionId);
    const replayed = (await client2.drain({ quietMs: 200, maxMs: 1500 })).filter(
      (m: AnyMsg) =>
        m.type === "agent_event"
        && m.event?.type === "agent_assistant"
        && m.event.content?.some((b: AnyMsg) => b.type === "text" && b.text === "INTERRUPT_CANARY partial"),
    );
    expect(replayed).toHaveLength(0);

    client2.close();
  });

  // -------------------------------------------------------------------------
  // Invariant: a turn ended by an ABNORMAL process exit (e.g. SIGTERM /
  // "exited with code 143" from an idle-kill, container restart, or crash) —
  // NOT a user interrupt — must finalize its streamed partial into history.
  // Otherwise the assistant rows stay `in_progress=1`, and the NEXT user
  // message's turn calls replaceInProgress(), deleting them — erasing the
  // previous turn from the UI on reload (the reported bug).
  // -------------------------------------------------------------------------

  it("an abnormal exit (code 143) preserves the prior turn when the next message is sent", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const sessionId = client.sessionId;

    // Turn 1: stream some assistant content, then the process dies with 143
    // WITHOUT a `result` event and WITHOUT a user interrupt.
    client.send({ type: "send_message", text: "first" });
    const turn1 = await waitForClaude(() => lastClaude);
    turn1.emit("event", { type: "system", subtype: "init", session_id: "abnormal-1" });
    await drainUntil(client, (m) => m.type === "session_started");
    turn1.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "EXIT143_CANARY answer" }] },
    });
    // A tool-result boundary is what writes the streamed groups to the DB as
    // in_progress=1 (the rows the next turn would otherwise wipe).
    turn1.emit("event", {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] },
    });
    await drainUntil(client, (m) => m.type === "agent_event" && m.event?.type === "agent_tool_result");

    // Process exits with 143 — bare `done`, no `result`, no interrupt.
    turn1.emit("done", 143);
    await settle(150);

    // Turn 2: a new message drives a fresh turn (this is the replaceInProgress
    // call that used to delete the unfinalized turn-1 rows).
    client.send({ type: "send_message", text: "second" });
    const turn2 = await waitForClaude(() => lastClaude, turn1);
    turn2.emit("event", { type: "system", subtype: "init", session_id: "abnormal-2" });
    turn2.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "SECOND_TURN reply" }] },
    });
    turn2.finish("abnormal-2");
    await settle(200);

    // History must still contain turn 1's assistant content alongside turn 2's,
    // and nothing should be left in-progress.
    const historyRes = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/history` });
    expect(historyRes.statusCode).toBe(200);
    const history = historyRes.json();
    const allText = history.messages
      .filter((m: AnyMsg) => m.role === "assistant")
      .map((m: AnyMsg) => m.text)
      .join("");
    expect(allText).toContain("EXIT143_CANARY answer");
    expect(allText).toContain("SECOND_TURN reply");
    for (const m of history.messages) {
      expect(m.inProgress).toBeFalsy();
    }

    client.close();
  });

  // -------------------------------------------------------------------------
  // Invariant: a WS reconnect AFTER the runner was disposed (idle cleanup
  // window expired) must spawn a fresh runner. Pins the registry-recreation
  // path that fires when getOrCreate() finds the session ID gone.
  // -------------------------------------------------------------------------

  it("WS reconnect after idle cleanup spawns a fresh runner and a new turn works", async () => {
    const client1 = await TestClient.connect(port);
    await client1.receive();
    const sessionId = client1.sessionId;

    // Run a turn to completion so running=false at WS close.
    client1.send({ type: "send_message", text: "first turn" });
    const turn1 = await waitForClaude(() => lastClaude);
    turn1.emit("event", { type: "system", subtype: "init", session_id: "agent-c1" });
    await drainUntil(client1, (m) => m.type === "session_started");
    turn1.finish("agent-c1");
    await settle(150);

    // Disconnect.
    client1.close();
    await settle();

    // Simulate idle cleanup completing — production fires this from the
    // periodic enforcer once IDLE_GRACE_PERIOD_MS elapses since the last
    // viewer detach. The test endpoint short-circuits the timer.
    const dispose = await app.inject({
      method: "POST",
      url: `/api/_test/dispose-runner/${sessionId}`,
    });
    expect(dispose.statusCode).toBe(200);

    // Confirm the runner is gone from the registry.
    const stateGone = await app.inject({ method: "GET", url: `/api/_test/runner/${sessionId}` });
    expect(stateGone.statusCode).toBe(404);

    // Reconnect to the same session ID. The WS handler must call
    // runnerRegistry.getOrCreate() since `get()` returns undefined.
    const client2 = await TestClient.connect(port, sessionId);
    await settle(50);

    // The runner must exist again.
    const stateBack = await app.inject({ method: "GET", url: `/api/_test/runner/${sessionId}` });
    expect(stateBack.statusCode).toBe(200);
    expect(stateBack.json().disposed).toBe(false);
    expect(stateBack.json().viewerCount).toBe(1);

    // Drive a new turn end-to-end on the freshly spawned runner.
    client2.send({ type: "send_message", text: "second turn" });
    const turn2 = await waitForClaude(() => lastClaude, turn1);
    expect(turn2.runCalled).toBe(true);
    expect(turn2.lastPrompt).toContain("second turn");
    turn2.emit("event", { type: "system", subtype: "init", session_id: "agent-c2" });
    turn2.finish("agent-c2");
    await settle(150);

    const status = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/status` });
    expect(status.json().running).toBe(false);

    client2.close();
  });

  // -------------------------------------------------------------------------
  // Invariant: multi-viewer support — two WS connections to the same session
  // both receive runner.emitMessage() broadcasts; closing one viewer doesn't
  // affect the other; the grace-period timer only starts after the LAST
  // viewer detaches.
  // -------------------------------------------------------------------------

  it("two viewers on one session both receive broadcasts; grace period waits for last detach", async () => {
    const clientA = await TestClient.connect(port);
    await clientA.receive();
    const sessionId = clientA.sessionId;

    // Second viewer attaches to the SAME session.
    const clientB = await TestClient.connect(port, sessionId);
    await settle(30);

    // Both viewers attached.
    const state2 = await app.inject({ method: "GET", url: `/api/_test/runner/${sessionId}` });
    expect(state2.json().viewerCount).toBe(2);
    expect(state2.json().lastViewerDetachAt).toBe(0);

    // Send a message — both clients should observe the broadcast events.
    clientA.send({ type: "send_message", text: "shared turn" });
    const claude = await waitForClaude(() => lastClaude);
    claude.emit("event", { type: "system", subtype: "init", session_id: "agent-mv1" });

    // Both clients receive session_started (broadcast via runner.emitMessage).
    const a = await drainUntil(clientA, (m) => m.type === "session_started");
    const b = await drainUntil(clientB, (m) => m.type === "session_started");
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect((a as AnyMsg).session.id).toBe((b as AnyMsg).session.id);

    // Detach ONE viewer. The runner stays alive, viewerCount drops to 1, and
    // the grace-period timer is NOT armed (only fires when the last viewer goes).
    clientB.close();
    await settle(50);

    const state1 = await app.inject({ method: "GET", url: `/api/_test/runner/${sessionId}` });
    expect(state1.json().viewerCount).toBe(1);
    expect(state1.json().lastViewerDetachAt).toBe(0);
    expect(state1.json().disposed).toBe(false);

    // Other viewer still works — finish the turn and assert running clears.
    claude.finish("agent-mv1");
    await settle(150);

    const status = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/status` });
    expect(status.json().running).toBe(false);

    // Detach the LAST viewer — grace period timer arms.
    clientA.close();
    await settle(50);
    const stateGone = await app.inject({ method: "GET", url: `/api/_test/runner/${sessionId}` });
    expect(stateGone.json().viewerCount).toBe(0);
    expect(stateGone.json().lastViewerDetachAt).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Invariant: archive (force-dispose) of a session whose agent is currently
  // running does kill the agent and tear down the runner. This is the user-
  // initiated counterpart to lifecycle-driven dispose, which must NOT kill
  // running agents. Production caller: services/session.ts:archiveSession().
  // -------------------------------------------------------------------------

  it("archiving a session with a running agent force-disposes the runner", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const sessionId = client.sessionId;

    // Start a turn and DON'T finish it — agent is still running.
    client.send({ type: "send_message", text: "long-running" });
    const claude = await waitForClaude(() => lastClaude);
    claude.emit("event", { type: "system", subtype: "init", session_id: "agent-arc-1" });
    await drainUntil(client, (m) => m.type === "session_started");

    // Pre-condition: runner is registered, agent is running.
    const before = await app.inject({ method: "GET", url: `/api/_test/runner/${sessionId}` });
    expect(before.json().running).toBe(true);

    // Archive the session — DELETE /api/sessions/:id triggers archiveSession()
    // which calls runnerRegistry.dispose(sessionId, { force: true }).
    const archive = await app.inject({ method: "DELETE", url: `/api/sessions/${sessionId}` });
    expect(archive.statusCode).toBe(200);
    await settle(50);

    // Runner is disposed and gone from the registry.
    const after = await app.inject({ method: "GET", url: `/api/_test/runner/${sessionId}` });
    expect(after.statusCode).toBe(404);

    // Forced disposal kills the agent process.
    expect(claude.killed).toBe(true);

    client.close();
  });

  // -------------------------------------------------------------------------
  // Invariant: post-turn commit message is correct even when the WS closed
  // before the agent finished. The commit message is derived from the
  // captured runner's `turnSummary`, NOT from `ctx.getTurnSummary()` (which
  // routes through the per-connection attachedRunner and returns "" after
  // disconnect). Pins the round-2 fix for the silent-mutation bug.
  // -------------------------------------------------------------------------

  it("post-turn commit message uses captured runner.turnSummary after WS disconnect", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const sessionId = client.sessionId;

    client.send({ type: "send_message", text: "commit me" });
    const claude = await waitForClaude(() => lastClaude);
    claude.emit("event", { type: "system", subtype: "init", session_id: "agent-pt-1" });
    const sessionMsg = await drainUntil(client, (m) => m.type === "session_started");
    const sessionDir = (sessionMsg as AnyMsg).session.workspaceDir as string;

    // Emit the assistant text BEFORE WS close so it's captured into
    // runner.turnSummary while the connection is still alive. Then add a
    // file change so auto-commit produces a real commit (no commit otherwise
    // and we'd have nothing to assert on).
    claude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "Created important.txt for you" }] },
    });
    fs.writeFileSync(path.join(sessionDir, "important.txt"), "hello");

    // Close the WS BEFORE the agent finishes — the post-turn commit fires
    // from inside the agent.on("done") closure, after the originating socket
    // is gone.
    client.close();
    await settle();

    // Drive the agent to completion. The "done" handler runs postTurnCommit()
    // with `runner.turnSummary` captured at turn start.
    claude.finish("agent-pt-1");
    await settle(300);

    // Reconnect and read history — the chat-history entry must be linked to
    // a commit whose message starts with the assistant text.
    const client2 = await TestClient.connect(port, sessionId);
    await settle(50);

    const historyRes = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/history` });
    expect(historyRes.statusCode).toBe(200);
    const history = historyRes.json();
    const commitMsgs = history.messages.filter((m: AnyMsg) => m.commitHash);
    expect(commitMsgs.length).toBeGreaterThan(0);

    // Read the commit message via git log — most reliable cross-check.
    const { GitManager } = await import("../../shared/git.js");
    const git = new GitManager(sessionDir);
    const log = await git.log(1);
    expect(log[0]?.message).toContain("Created important.txt for you");

    client2.close();
  });
});
