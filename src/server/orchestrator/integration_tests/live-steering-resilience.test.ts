/**
 * Integration tests for live-steering resilience (docs/140, Phase 5).
 *
 * These pin the lifecycle contracts where live steering (docs/140) intersects
 * the "WebSocket lifecycle MUST NOT affect server behavior" rules (CLAUDE.md /
 * ws-disconnect-resilience.test.ts). Steering injects a user message mid-turn
 * through a persistent streaming process, which changes the assumptions a
 * disconnect / session-switch / interrupt would otherwise rely on:
 *
 *   1. Steer-then-disconnect/reconnect — a mid-turn steer is broadcast via
 *      `runner.emitMessage`, so it lands in the turn-event replay buffer and a
 *      reconnecting viewer sees it again; the running state survives the WS
 *      drop; the steered message persists exactly once (no double-render).
 *   2. Steer-during-session-switch — the steer is addressed to the runner that
 *      owns the in-flight turn (resolved via the registry at handler entry),
 *      NOT to whatever session the message names / the connection is switching
 *      to. The steer reaches the running runner's agent, not the other one.
 *   3. Interrupt during a steered turn — `interrupt()` is a `control_request`
 *      that ends the turn WITHOUT killing the persistent process (Phase 6.7 —
 *      no exit-143 force-kill); a subsequent message reuses the same resident
 *      process and proceeds.
 *
 * Steering is opted into via `credentialStore.setLiveSteering(true)` (the
 * agent registry already advertises `supportsSteering: true` for claude). The
 * FakeClaudeProcess records `sendUserMessage` calls under `stdinData` (its
 * default `sendUserMessage` proxies to `writeStdin`).
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
import type { CredentialStore } from "../credential-store.js";
import { DatabaseManager } from "../../shared/database.js";

// Test code asserts on heterogeneous ws messages at runtime — `any` is fine.
type AnyMsg = any;

describe("Integration: live-steering resilience (docs/140 Phase 5)", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let credentialStore: CredentialStore;
  let lastClaude: FakeClaudeProcess = null as never;
  let dbManager: DatabaseManager;
  let chatHistoryManager: ChatHistoryManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    lastClaude = null as never;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-steer-resilience-"));
    credentialStore = createTestCredentialStore(tmpDir);
    // Live steering on for the whole suite; claude's registry capability
    // (`supportsSteering: true`) covers the adapter side.
    credentialStore.setLiveSteering(true);

    const sessionManager = new SessionManager(dbManager);
    chatHistoryManager = new ChatHistoryManager(dbManager);

    app = await buildApp({
      credentialStore,
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
    } catch {
      // Ignore cleanup errors
    }
  });

  /** Drain messages until predicate returns truthy, up to maxMsgs attempts. */
  async function drainUntil(
    client: TestClient,
    predicate: (m: AnyMsg) => boolean,
    maxMsgs = 40,
    timeoutMs = 3000,
  ): Promise<AnyMsg> {
    for (let i = 0; i < maxMsgs; i++) {
      const msg: AnyMsg = await client.receive(timeoutMs);
      if (predicate(msg)) return msg;
    }
    return null;
  }

  /** Wait until `claude.stdinData` contains a substring (sendUserMessage landed). */
  async function waitForStdin(claude: FakeClaudeProcess, needle: string, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (true) {
      if (claude.stdinData.some((d) => d.includes(needle))) return;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`sendUserMessage carrying ${JSON.stringify(needle)} never landed`);
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

  // -------------------------------------------------------------------------
  // 1. Steer mid-turn, drop the WS, reconnect: the steer replays from the
  //    turn-event buffer, running state survives, and the steered message
  //    persists exactly once (no double-render).
  // -------------------------------------------------------------------------

  it("replays a mid-turn steer from the turn-event buffer on reconnect, running survives, no double-render", async () => {
    const client1 = await TestClient.connect(port);
    await client1.receive(); // preview_status
    const sessionId = client1.sessionId;

    // Turn 1 — kick off the streaming agent.
    client1.send({ type: "send_message", text: "Implement feature" });
    const claude = await waitForClaude(() => lastClaude);
    expect(claude.lastUseStreaming).toBe(true);
    claude.initSession("steer-disc-session");

    // First assistant group + its tool result. The tool-result boundary
    // persists the group as in-progress AND advances `lastPersistedBufferIndex`
    // — so the only thing the reconnect replay should re-emit is the steer that
    // arrives *after* this boundary (persisted content is loaded over HTTP, not
    // replayed — that's what "no double-render" means at the buffer level).
    claude.emit("event", {
      type: "assistant",
      message: { content: [
        { type: "text", text: "working" },
        { type: "tool_use", id: "tu-1", name: "Write", input: {} },
      ] },
    });
    claude.emit("event", {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tu-1", content: "ok" }] },
    });

    // Steer mid-turn — broadcast via runner.emitMessage (→ turn-event buffer).
    client1.send({ type: "send_message", text: "actually do X" });
    const steered = await drainUntil(client1, (m) => m.type === "message_steered");
    expect(steered).toMatchObject({ type: "message_steered", text: "actually do X" });
    expect(claude.stdinData).toContain("actually do X");

    // The originating WS drops mid-turn (turn still running). Server state must
    // not change — runner survives in the registry, agent not killed.
    client1.close();
    await settle();
    expect(claude.killed).toBe(false);

    // A new viewer reconnects to the same session.
    const client2 = await TestClient.connect(port, sessionId);

    // The steer replays from the turn-event buffer (it was emitted via
    // runner.emitMessage, so the reconnect's buffer replay re-sends it).
    const replayedSteer = await drainUntil(client2, (m) => m.type === "message_steered");
    expect(replayedSteer).toMatchObject({ type: "message_steered", text: "actually do X" });

    // Running state survives the reconnect — the attach replay re-announces it.
    const runningStatus = await drainUntil(
      client2,
      (m) => m.type === "session_status" && (m as AnyMsg).running === true,
    );
    expect(runningStatus).toMatchObject({ running: true });

    // Finish the turn on the persistent process. The reconnected viewer sees
    // the turn complete even though the originating socket is long gone.
    claude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "did X" }] },
    });
    claude.emit("event", { type: "result", subtype: "success", session_id: "steer-disc-session" });
    const finishedStatus = await drainUntil(
      client2,
      (m) => m.type === "session_status" && (m as AnyMsg).running === false,
    );
    expect(finishedStatus).toMatchObject({ running: false });

    // No double-render: the steered user message persists exactly once, at its
    // true transcript position (after the first assistant group, before the
    // second).
    const history = chatHistoryManager.load(sessionId);
    const steerRows = history.filter((m) => m.role === "user" && m.text === "actually do X");
    expect(steerRows).toHaveLength(1);
    expect(history.map((m) => ({ role: m.role, text: m.text }))).toEqual([
      { role: "user", text: "Implement feature" },
      { role: "assistant", text: "working" },
      { role: "user", text: "actually do X" },
      { role: "assistant", text: "did X" },
    ]);

    client2.close();
  });

  // -------------------------------------------------------------------------
  // 2. Steer-during-session-switch targets the runner that owns the in-flight
  //    turn (resolved via the registry at handler entry), NOT the session the
  //    message names. The steer reaches A's agent, never B's.
  // -------------------------------------------------------------------------

  it("steers into the runner that owns the in-flight turn, not the session the message names", async () => {
    // Session A — start a streaming turn and leave it running.
    const clientA = await TestClient.connect(port);
    await clientA.receive(); // preview_status
    const sessionA = clientA.sessionId;
    clientA.send({ type: "send_message", text: "Turn on A" });
    const claudeA = await waitForClaude(() => lastClaude);
    expect(claudeA.lastUseStreaming).toBe(true);
    claudeA.initSession("session-A-agent");

    // Session B — a separate session whose streaming agent has *finished* its
    // turn (so it's idle, but its resident process ref persists — streaming
    // only clears the ref on `done`/dispose). Gives us a concrete "wrong"
    // target to assert the steer does NOT reach.
    const clientB = await TestClient.connect(port);
    await clientB.receive(); // preview_status
    const sessionB = clientB.sessionId;
    clientB.send({ type: "send_message", text: "Turn on B" });
    const claudeB = await waitForClaude(() => lastClaude, claudeA);
    expect(claudeB).not.toBe(claudeA);
    claudeB.initSession("session-B-agent");
    claudeB.emit("event", { type: "result", subtype: "success", session_id: "session-B-agent" });
    await drainUntil(clientB, (m) => m.type === "session_status" && (m as AnyMsg).running === false);

    const runnerA = (app as AnyMsg).runnerRegistry.get(sessionA);
    const runnerB = (app as AnyMsg).runnerRegistry.get(sessionB);
    expect(runnerA.running).toBe(true);
    expect(runnerB.running).toBe(false);

    // On A's connection, send a message that NAMES session B — modelling a
    // mid-turn session switch where the message targets B. Because A's turn is
    // in flight, `handleSendMessage` resolves the runner at handler entry (via
    // A's still-active session id, before any switch takes effect) and steers
    // the message into A. The `sessionId: B` is effectively ignored for the
    // steer decision: the steer follows the running turn, not the named session.
    clientA.send({ type: "send_message", text: "steer payload", sessionId: sessionB });

    // The steer is broadcast on A's runner (capturedSessionId === A).
    const steered = await drainUntil(clientA, (m) => m.type === "message_steered");
    expect(steered).toMatchObject({ type: "message_steered", text: "steer payload", sessionId: sessionA });

    // It reached A's agent, NOT B's.
    expect(claudeA.stdinData).toContain("steer payload");
    expect(claudeB.stdinData).not.toContain("steer payload");

    // No new turn was started on B (it stayed idle, no fresh spawn).
    expect(runnerB.running).toBe(false);
    expect(lastClaude).toBe(claudeB);

    clientA.close();
    clientB.close();
  });

  // -------------------------------------------------------------------------
  // 3. Interrupt during a steered turn: interrupt() is a control_request that
  //    ends the turn WITHOUT killing the persistent process (Phase 6.7 — no
  //    exit-143 force-kill); the next message reuses the same resident process.
  // -------------------------------------------------------------------------

  it("interrupt during a steered turn does not kill the persistent process; the next message reuses it", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "Start steered turn" });
    const claude = await waitForClaude(() => lastClaude);
    expect(claude.lastUseStreaming).toBe(true);
    claude.initSession("steer-interrupt-session");

    // Model the STREAMING interrupt: control_request ends the turn but the
    // process stays resident (no `done`, no force-kill / exit-143).
    claude.streamingInterrupt = true;

    // Interrupt mid-turn.
    client.send({ type: "interrupt_agent" });
    const interrupted = await drainUntil(client, (m) => m.type === "agent_interrupted");
    expect(interrupted).toBeTruthy();
    // The orchestrator routed through interrupt(), NOT kill().
    expect(claude.interrupted).toBe(true);
    expect(claude.killed).toBe(false);

    // The CLI ends the interrupted turn with a result (error_during_execution);
    // the persistent process does not exit.
    claude.emit("event", {
      type: "result",
      subtype: "error_during_execution",
      session_id: "steer-interrupt-session",
    });
    await drainUntil(client, (m) => m.type === "session_status" && (m as AnyMsg).running === false);

    // The persistent process survived the interrupt: still resident, streaming
    // gate intact, never killed.
    const runner = (app as AnyMsg).runnerRegistry.get(client.sessionId);
    expect(runner.getAgent()).toBe(claude);
    expect(runner.isStreamingActive).toBe(true);
    expect(claude.killed).toBe(false);

    // A subsequent message proceeds — on the SAME resident process, carried in
    // via sendUserMessage (not a fresh spawn, not a kill+respawn).
    client.send({ type: "send_message", text: "Continue after interrupt" });
    await waitForStdin(claude, "Continue after interrupt");
    expect(lastClaude).toBe(claude);
    expect(claude.killed).toBe(false);

    client.close();
  });
});
