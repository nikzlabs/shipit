import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import { DatabaseManager } from "../../shared/database.js";

import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { testDispatch } from "./dispatch-test-helpers.js";

type AnyMsg = Record<string, unknown> & { type: string };

describe("Integration: dispatched turn vs WS turn race", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let chatHistoryManager: ChatHistoryManager;
  let lastClaude: FakeClaudeProcess | null = null;
  let allClaudes: FakeClaudeProcess[] = [];
  let dbManager: DatabaseManager;
  let stubAuth: StubAuthManager;
  let credentialStore: ReturnType<typeof createTestCredentialStore>;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    lastClaude = null;
    allClaudes = [];
    stubAuth = new StubAuthManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-race-"));

    sessionManager = new SessionManager(dbManager);
    chatHistoryManager = new ChatHistoryManager(dbManager);
    credentialStore = createTestCredentialStore(tmpDir);

    app = await buildApp({
      credentialStore,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      chatHistoryManager,
      authManager: stubAuth as unknown as AuthManager,
      agentFactory: () => {
        const claude = new FakeClaudeProcess();
        lastClaude = claude;
        allClaudes.push(claude);
        return claude as any;
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
    maxMsgs = 30,
    timeoutMs = 2000,
  ): Promise<AnyMsg | null> {
    for (let i = 0; i < maxMsgs; i++) {
      const msg = (await client.receive(timeoutMs)) as AnyMsg;
      if (predicate(msg)) return msg;
    }
    return null;
  }

  it("dispatched turn's agent receives events emitted on its own process", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${client.sessionId}/agent/dispatch`,
      payload: { text: "[ci-fix] mock", activity: "Auto-fixing CI…" },
    });
    expect(res.statusCode).toBe(200);

    const dispatchedAgent = await waitForClaude(() => lastClaude);

    const sawInit = new Promise<boolean>((resolve) => {
      dispatchedAgent.on("event", (event: { type?: string }) => {
        if (event.type === "agent_init") resolve(true);
      });
      setTimeout(() => resolve(false), 1000);
    });
    const sawAssistant = new Promise<boolean>((resolve) => {
      dispatchedAgent.on("event", (event: { type?: string }) => {
        if (event.type === "agent_assistant") resolve(true);
      });
      setTimeout(() => resolve(false), 1000);
    });

    dispatchedAgent.emit("event", { type: "system", subtype: "init", session_id: "agent-session-dispatch" });
    dispatchedAgent.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "Working on it." }] },
    });

    expect(await sawInit).toBe(true);
    expect(await sawAssistant).toBe(true);

    client.close();
  });

  it("concurrent WS send_message can NOT clobber an active dispatched turn's agent slot", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    const dispatchPromise = app.inject({
      method: "POST",
      url: `/api/sessions/${client.sessionId}/agent/dispatch`,
      payload: { text: "[ci-fix] dispatched prompt" },
    });
    client.send({ type: "send_message", text: "concurrent ws" });

    const dispatchRes = await dispatchPromise;
    expect(dispatchRes.statusCode).toBe(200);

    const dispatchedAgent = await waitForClaude(() => lastClaude);
    expect(dispatchedAgent.lastPrompt).toBe("[ci-fix] dispatched prompt");

    const queued = await drainUntil(client, (m) => m.type === "message_queued");
    expect(queued).toMatchObject({ type: "message_queued", text: "concurrent ws" });

    expect(allClaudes.length).toBe(1);
    expect(allClaudes[0]).toBe(dispatchedAgent);

    const receivedEventTypes: string[] = [];
    dispatchedAgent.on("event", (event: { type?: string }) => {
      if (event.type) receivedEventTypes.push(event.type);
    });

    dispatchedAgent.emit("event", { type: "system", subtype: "init", session_id: "s-dispatched" });
    dispatchedAgent.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "Fixing the CI issue." }] },
    });

    expect(receivedEventTypes).toContain("agent_init");
    expect(receivedEventTypes).toContain("agent_assistant");

    client.close();
  });

  it("a stale done handler from a prior turn does NOT clear a later turn's agent slot", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    const firstRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${client.sessionId}/agent/dispatch`,
      payload: { text: "first" },
    });
    expect(firstRes.statusCode).toBe(200);
    const firstAgent = await waitForClaude(() => lastClaude);

    await drainUntil(client, (m) => m.type === "system_user_message");

    const secondRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${client.sessionId}/agent/dispatch`,
      payload: { text: "second" },
    });
    expect(secondRes.statusCode).toBe(200);
    expect(secondRes.json()).toMatchObject({ ok: true, queued: true });

    const queued = await drainUntil(client, (m) => m.type === "message_queued");
    expect(queued).toMatchObject({ text: "second" });

    firstAgent.finish("s-first");

    const secondAgent = await waitForClaude(() => lastClaude, firstAgent);
    expect(secondAgent.lastPrompt).toBe("second");
    expect(secondAgent).not.toBe(firstAgent);

    const captured: string[] = [];
    secondAgent.on("event", (event: { type?: string }) => {
      if (event.type) captured.push(event.type);
    });

    secondAgent.emit("event", { type: "system", subtype: "init", session_id: "s-second" });
    secondAgent.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "Second turn working." }] },
    });

    expect(captured).toContain("agent_init");
    expect(captured).toContain("agent_assistant");

    client.close();
  });

  it("a dispatched turn reuses a resident streaming agent instead of spawning a competing one-shot (docs/146 prod race)", async () => {
    credentialStore.setLiveSteering(true);

    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "first turn" });
    const streamingAgent = await waitForClaude(() => lastClaude);
    streamingAgent.initSession("race-resident-session");
    expect((streamingAgent as any).lastUseStreaming).toBe(true);

    const runner = (app as any).runnerRegistry.get(client.sessionId);
    await waitUntil(() => runner.running && runner.isStreamingActive && runner.getAgent());

    streamingAgent.emit("event", { type: "result", subtype: "success", session_id: "race-resident-session" });
    await waitUntil(() => !runner.running && runner.isStreamingActive && runner.getAgent());

    credentialStore.setLiveSteering(false);
    runner.dispatch(testDispatch({ text: "second instruction" }));

    await waitUntil(() => streamingAgent.stdinData.includes("second instruction"));
    expect(allClaudes.length).toBe(1);
    expect(lastClaude).toBe(streamingAgent);
    expect(runner.getAgent()).toBe(streamingAgent);

    client.close();
  });
});

async function waitUntil(fn: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitUntil timed out");
}
