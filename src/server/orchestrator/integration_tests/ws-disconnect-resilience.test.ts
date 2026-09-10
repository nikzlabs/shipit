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
  waitFor,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";

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

  async function drainUntil(client: TestClient, pred: (m: AnyMsg) => boolean, maxMsgs = 50): Promise<AnyMsg> {
    for (let i = 0; i < maxMsgs; i++) {
      const m: AnyMsg = await client.receive(3000);
      if (pred(m)) return m;
    }
    return null;
  }

  const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms));

  it("WS close does not kill the agent process", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Hello" });
    const claude = await waitForClaude(() => lastClaude);
    expect(claude.runCalled).toBe(true);

    client.close();
    await settle();

    expect(claude.killed).toBe(false);
    expect(claude.interrupted).toBe(false);
  });

  it("runner.running is cleared after agent finishes, even if WS already closed", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const sessionId = client.sessionId;

    client.send({ type: "send_message", text: "Hello" });
    const claude = await waitForClaude(() => lastClaude);
    claude.emit("event", { type: "system", subtype: "init", session_id: "agent-1" });
    await drainUntil(client, (m) => m.type === "session_started");

    client.close();
    await settle();

    claude.finish("agent-1");
    await settle(150);

    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/status` });
    expect(res.statusCode).toBe(200);
    expect(res.json().running).toBe(false);
  });

  it("post-turn events emitted after WS close are buffered and replayed on reconnect", async () => {
    const client1 = await TestClient.connect(port);
    await client1.receive();
    const sessionId = client1.sessionId;

    client1.send({ type: "send_message", text: "Hello" });
    const claude = await waitForClaude(() => lastClaude);
    claude.emit("event", { type: "system", subtype: "init", session_id: "agent-2" });
    await drainUntil(client1, (m) => m.type === "session_started");

    client1.close();
    await settle();

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

    const client2 = await TestClient.connect(port, sessionId);
    const historyRes = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/history` });
    expect(historyRes.statusCode).toBe(200);
    const history = historyRes.json();
    expect(history.agentRunning).toBe(false);
    const assistantMsgs = history.messages.filter((m: AnyMsg) => m.role === "assistant");
    expect(assistantMsgs.some((m: AnyMsg) => (m.text ?? "").includes("All done"))).toBe(true);

    client2.close();
  });

  it("unpersisted streaming events emitted after WS close reach a reconnecting viewer", async () => {
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
        m.type === "turn_snapshot"
        && m.messages?.some((msg: AnyMsg) => msg.text === "background chunk"),
    );

    expect(replayed).toBeTruthy();
    client2.close();
  });

  it("queued messages drain correctly after the originating WS closes", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const sessionId = client.sessionId;

    client.send({ type: "send_message", text: "Turn 1" });
    const turn1 = await waitForClaude(() => lastClaude);
    turn1.emit("event", { type: "system", subtype: "init", session_id: "agent-q1" });
    await drainUntil(client, (m) => m.type === "session_started");

    client.send({ type: "send_message", text: "Turn 2 (queued)" });
    await drainUntil(client, (m) => m.type === "message_queued");

    client.close();
    await settle();

    turn1.finish("agent-q1");
    const turn2 = await waitForClaude(() => lastClaude, turn1);
    expect(turn2.runCalled).toBe(true);
    expect(turn2.lastPrompt).toContain("Turn 2 (queued)");

    turn2.emit("event", { type: "system", subtype: "init", session_id: "agent-q2" });
    turn2.finish("agent-q2");
    await settle(200);

    const status = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/status` });
    expect(status.json().running).toBe(false);
  });

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

    const client2 = await TestClient.connect(port, sessionId);
    const status = await drainUntil(client2, (m) => m.type === "session_status");
    expect(status).toBeTruthy();
    expect(status!.running).toBe(true);

    claude.finish("agent-r1");
    client2.close();
  });

  it("disconnecting one session leaves another session's running agent untouched", async () => {
    const clientA = await TestClient.connect(port);
    await clientA.receive();
    clientA.send({ type: "send_message", text: "A" });
    const agentA = await waitForClaude(() => lastClaude);
    agentA.emit("event", { type: "system", subtype: "init", session_id: "agent-a" });
    await drainUntil(clientA, (m) => m.type === "session_started");

    const clientB = await TestClient.connect(port);
    await clientB.receive();
    clientB.send({ type: "send_message", text: "B" });
    const agentB = await waitForClaude(() => lastClaude, agentA);
    agentB.emit("event", { type: "system", subtype: "init", session_id: "agent-b" });
    await drainUntil(clientB, (m) => m.type === "session_started");

    clientB.close();
    await settle();

    expect(agentA.killed).toBe(false);
    expect(agentA.interrupted).toBe(false);

    expect(agentB.killed).toBe(false);

    agentA.finish("agent-a");
    agentB.finish("agent-b");
    await settle(150);

    clientA.close();
  });

  it("close immediately after send_message still drains the turn correctly", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const sessionId = client.sessionId;

    client.send({ type: "send_message", text: "race" });
    client.close();
    await settle();

    const claude = await waitForClaude(() => lastClaude);
    expect(claude.runCalled).toBe(true);

    claude.emit("event", { type: "system", subtype: "init", session_id: "race-1" });
    claude.finish("race-1");
    await settle(150);

    const status = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/status` });
    expect(status.json().running).toBe(false);
  });

  it("agent error without `done` still clears `running` (runner stays disposable)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const sessionId = client.sessionId;

    client.send({ type: "send_message", text: "go" });
    const claude = await waitForClaude(() => lastClaude);
    claude.emit("event", { type: "system", subtype: "init", session_id: "err-1" });
    await drainUntil(client, (m) => m.type === "session_started");

    (claude as unknown as { emit: (n: string, e: Error) => void }).emit(
      "error",
      new Error("simulated spawn failure"),
    );
    await settle(150);

    const status = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/status` });
    expect(status.statusCode).toBe(200);
    expect(status.json().running).toBe(false);

    client.close();
  });

  it("an errored turn is not replayed on reconnect (no duplicate)", async () => {
    const client1 = await TestClient.connect(port);
    await client1.receive();
    const sessionId = client1.sessionId;

    client1.send({ type: "send_message", text: "go" });
    const claude = await waitForClaude(() => lastClaude);
    claude.emit("event", { type: "system", subtype: "init", session_id: "dup-err-1" });
    await drainUntil(client1, (m) => m.type === "session_started");

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

    const state = await app.inject({ method: "GET", url: `/api/_test/runner/${sessionId}` });
    expect(state.statusCode).toBe(200);
    expect(state.json().turnEventBufferTypes).not.toContain("agent_event");

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

    const historyRes = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/history` });
    const occurrences = historyRes.json().messages.filter(
      (m: AnyMsg) => (m.text ?? "").includes("REPLAY_CANARY answer"),
    );
    expect(occurrences).toHaveLength(1);

    client2.close();
  });

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

    client1.send({ type: "interrupt_agent" });
    await settle(150);

    const state = await app.inject({ method: "GET", url: `/api/_test/runner/${sessionId}` });
    expect(state.statusCode).toBe(200);
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

  it("an abnormal exit (code 143) preserves the prior turn when the next message is sent", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const sessionId = client.sessionId;

    client.send({ type: "send_message", text: "first" });
    const turn1 = await waitForClaude(() => lastClaude);
    turn1.emit("event", { type: "system", subtype: "init", session_id: "abnormal-1" });
    await drainUntil(client, (m) => m.type === "session_started");
    turn1.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "EXIT143_CANARY answer" }] },
    });
    // A tool-result boundary persists the partial turn before the process exits.
    turn1.emit("event", {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] },
    });
    await drainUntil(client, (m) => m.type === "agent_event" && m.event?.type === "agent_tool_result");

    turn1.emit("done", 143);
    await settle(150);

    client.send({ type: "send_message", text: "second" });
    const turn2 = await waitForClaude(() => lastClaude, turn1);
    turn2.emit("event", { type: "system", subtype: "init", session_id: "abnormal-2" });
    turn2.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "SECOND_TURN reply" }] },
    });
    turn2.finish("abnormal-2");
    await settle(200);

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

  it("WS reconnect after idle cleanup spawns a fresh runner and a new turn works", async () => {
    const client1 = await TestClient.connect(port);
    await client1.receive();
    const sessionId = client1.sessionId;

    client1.send({ type: "send_message", text: "first turn" });
    const turn1 = await waitForClaude(() => lastClaude);
    turn1.emit("event", { type: "system", subtype: "init", session_id: "agent-c1" });
    await drainUntil(client1, (m) => m.type === "session_started");
    turn1.finish("agent-c1");
    await settle(150);

    client1.close();
    await settle();

    const dispose = await app.inject({
      method: "POST",
      url: `/api/_test/dispose-runner/${sessionId}`,
    });
    expect(dispose.statusCode).toBe(200);

    const stateGone = await app.inject({ method: "GET", url: `/api/_test/runner/${sessionId}` });
    expect(stateGone.statusCode).toBe(404);

    const client2 = await TestClient.connect(port, sessionId);
    await settle(50);

    const stateBack = await app.inject({ method: "GET", url: `/api/_test/runner/${sessionId}` });
    expect(stateBack.statusCode).toBe(200);
    expect(stateBack.json().disposed).toBe(false);
    expect(stateBack.json().viewerCount).toBe(1);

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

  it("two viewers on one session both receive broadcasts; grace period waits for last detach", async () => {
    const clientA = await TestClient.connect(port);
    await clientA.receive();
    const sessionId = clientA.sessionId;

    const clientB = await TestClient.connect(port, sessionId);
    await settle(30);

    const state2 = await app.inject({ method: "GET", url: `/api/_test/runner/${sessionId}` });
    expect(state2.json().viewerCount).toBe(2);
    expect(state2.json().lastViewerDetachAt).toBe(0);

    clientA.send({ type: "send_message", text: "shared turn" });
    const claude = await waitForClaude(() => lastClaude);
    claude.emit("event", { type: "system", subtype: "init", session_id: "agent-mv1" });

    const a = await drainUntil(clientA, (m) => m.type === "session_started");
    const b = await drainUntil(clientB, (m) => m.type === "session_started");
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect((a as AnyMsg).session.id).toBe((b as AnyMsg).session.id);

    clientB.close();
    await settle(50);

    const state1 = await app.inject({ method: "GET", url: `/api/_test/runner/${sessionId}` });
    expect(state1.json().viewerCount).toBe(1);
    expect(state1.json().lastViewerDetachAt).toBe(0);
    expect(state1.json().disposed).toBe(false);

    claude.finish("agent-mv1");
    await settle(150);

    const status = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/status` });
    expect(status.json().running).toBe(false);

    clientA.close();
    await waitFor(async () => {
      const r = await app.inject({ method: "GET", url: `/api/_test/runner/${sessionId}` });
      return r.json().viewerCount === 0;
    }, "last viewer detached");
    const stateGone = await app.inject({ method: "GET", url: `/api/_test/runner/${sessionId}` });
    expect(stateGone.json().viewerCount).toBe(0);
    expect(stateGone.json().lastViewerDetachAt).toBeGreaterThan(0);
  });

  it("archiving a session with a running agent force-disposes the runner", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const sessionId = client.sessionId;

    client.send({ type: "send_message", text: "long-running" });
    const claude = await waitForClaude(() => lastClaude);
    claude.emit("event", { type: "system", subtype: "init", session_id: "agent-arc-1" });
    await drainUntil(client, (m) => m.type === "session_started");

    const before = await app.inject({ method: "GET", url: `/api/_test/runner/${sessionId}` });
    expect(before.json().running).toBe(true);

    const archive = await app.inject({ method: "DELETE", url: `/api/sessions/${sessionId}` });
    expect(archive.statusCode).toBe(200);
    await settle(50);

    const after = await app.inject({ method: "GET", url: `/api/_test/runner/${sessionId}` });
    expect(after.statusCode).toBe(404);

    expect(claude.killed).toBe(true);

    client.close();
  });

  it("post-turn commit message uses captured runner.turnSummary after WS disconnect", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const sessionId = client.sessionId;

    client.send({ type: "send_message", text: "commit me" });
    const claude = await waitForClaude(() => lastClaude);
    claude.emit("event", { type: "system", subtype: "init", session_id: "agent-pt-1" });
    const sessionMsg = await drainUntil(client, (m) => m.type === "session_started");
    const sessionDir = (sessionMsg as AnyMsg).session.workspaceDir as string;

    claude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "Created important.txt for you" }] },
    });
    fs.writeFileSync(path.join(sessionDir, "important.txt"), "hello");

    client.close();
    await settle();

    claude.finish("agent-pt-1");

    const client2 = await TestClient.connect(port, sessionId);

    await waitFor(async () => {
      const r = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/history` });
      return r.json().messages.some((m: AnyMsg) => m.commitHash);
    }, "post-turn commit persisted to history");

    const historyRes = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/history` });
    expect(historyRes.statusCode).toBe(200);
    const history = historyRes.json();
    const commitMsgs = history.messages.filter((m: AnyMsg) => m.commitHash);
    expect(commitMsgs.length).toBeGreaterThan(0);

    const { GitManager } = await import("../../shared/git.js");
    const git = new GitManager(sessionDir);
    const log = await git.log(1);
    expect(log[0]?.message).toContain("Created important.txt for you");

    client2.close();
  });
});
