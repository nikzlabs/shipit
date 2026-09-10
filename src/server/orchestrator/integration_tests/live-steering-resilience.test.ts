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

  it("replays a mid-turn steer from the turn-event buffer on reconnect, running survives, no double-render", async () => {
    const client1 = await TestClient.connect(port);
    await client1.receive();
    const sessionId = client1.sessionId;

    client1.send({ type: "send_message", text: "Implement feature" });
    const claude = await waitForClaude(() => lastClaude);
    expect(claude.lastUseStreaming).toBe(true);
    claude.initSession("steer-disc-session");

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

    client1.send({ type: "send_message", text: "actually do X" });
    const steered = await drainUntil(client1, (m) => m.type === "message_steered");
    expect(steered).toMatchObject({ type: "message_steered", text: "actually do X" });
    expect(claude.stdinData).toContain("actually do X");

    client1.close();
    await settle();
    expect(claude.killed).toBe(false);

    const client2 = await TestClient.connect(port, sessionId);

    const replayedSteer = await drainUntil(client2, (m) => m.type === "message_steered");
    expect(replayedSteer).toMatchObject({ type: "message_steered", text: "actually do X" });

    const runningStatus = await drainUntil(
      client2,
      (m) => m.type === "session_status" && (m as AnyMsg).running === true,
    );
    expect(runningStatus).toMatchObject({ running: true });

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

  it("steers into the runner that owns the in-flight turn, not the session the message names", async () => {
    const clientA = await TestClient.connect(port);
    await clientA.receive();
    const sessionA = clientA.sessionId;
    clientA.send({ type: "send_message", text: "Turn on A" });
    const claudeA = await waitForClaude(() => lastClaude);
    expect(claudeA.lastUseStreaming).toBe(true);
    claudeA.initSession("session-A-agent");

    const clientB = await TestClient.connect(port);
    await clientB.receive();
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

    clientA.send({ type: "send_message", text: "steer payload", sessionId: sessionB });

    const steered = await drainUntil(clientA, (m) => m.type === "message_steered");
    expect(steered).toMatchObject({ type: "message_steered", text: "steer payload", sessionId: sessionA });

    expect(claudeA.stdinData).toContain("steer payload");
    expect(claudeB.stdinData).not.toContain("steer payload");

    expect(runnerB.running).toBe(false);
    expect(lastClaude).toBe(claudeB);

    clientA.close();
    clientB.close();
  });

  it("interrupt during a steered turn does not kill the persistent process; the next message reuses it", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Start steered turn" });
    const claude = await waitForClaude(() => lastClaude);
    expect(claude.lastUseStreaming).toBe(true);
    claude.initSession("steer-interrupt-session");

    claude.streamingInterrupt = true;

    client.send({ type: "interrupt_agent" });
    const interrupted = await drainUntil(client, (m) => m.type === "agent_interrupted");
    expect(interrupted).toBeTruthy();
    expect(claude.interrupted).toBe(true);
    expect(claude.killed).toBe(false);

    claude.emit("event", {
      type: "result",
      subtype: "error_during_execution",
      session_id: "steer-interrupt-session",
    });
    await drainUntil(client, (m) => m.type === "session_status" && (m as AnyMsg).running === false);

    const runner = (app as AnyMsg).runnerRegistry.get(client.sessionId);
    expect(runner.getAgent()).toBe(claude);
    expect(runner.isStreamingActive).toBe(true);
    expect(claude.killed).toBe(false);

    client.send({ type: "send_message", text: "Continue after interrupt" });
    await waitForStdin(claude, "Continue after interrupt");
    expect(lastClaude).toBe(claude);
    expect(claude.killed).toBe(false);

    client.close();
  });
});
