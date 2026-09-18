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
import { testDispatch } from "./dispatch-test-helpers.js";
import { imageHash } from "../transcript-projection.js";

type AnyMsg = any;

describe("Integration: live steering (docs/140)", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let credentialStore: CredentialStore;
  let lastClaude: FakeClaudeProcess = null as any;
  let dbManager: DatabaseManager;
  let chatHistoryManager: ChatHistoryManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-steering-"));
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
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors
    }
  });

  async function drainUntil(client: TestClient, predicate: (m: AnyMsg) => boolean, maxMsgs = 30, timeoutMs = 2000): Promise<AnyMsg> {
    for (let i = 0; i < maxMsgs; i++) {
      const msg: AnyMsg = await client.receive(timeoutMs);
      if (predicate(msg)) return msg;
    }
    return null;
  }

  it("starts the agent with useStreaming=true when liveSteering is on and agent supports it", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Hello" });
    const claude = await waitForClaude(() => lastClaude);
    expect((claude as any).lastUseStreaming).toBe(true);

    client.close();
  });

  it("steers a mid-turn message via sendUserMessage and emits message_steered (not message_queued)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "First message" });
    const claude = await waitForClaude(() => lastClaude);
    claude.initSession("steer-session-1");

    client.send({ type: "send_message", text: "Steer me" });

    const steered = await drainUntil(client, (m) => m.type === "message_steered");
    expect(steered).toMatchObject({ type: "message_steered", text: "Steer me" });

    expect(claude.stdinData).toContain("Steer me");

    client.close();
  });

  it("echoes a steered image as a content-addressed URL, not base64 (docs/244, planning#299)", async () => {
    const png = Buffer.from("steered-png-bytes").toString("base64");

    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "First message" });
    const claude = await waitForClaude(() => lastClaude);
    claude.initSession("steer-image-session");

    client.send({
      type: "send_message",
      text: "look at this",
      images: [{ data: png, mediaType: "image/png" }],
    });

    const steered = await drainUntil(client, (m) => m.type === "message_steered");
    expect(steered.images).toHaveLength(1);
    expect(steered.images[0].data).toBeUndefined();
    expect(steered.images[0].src).toBe(`/api/sessions/${client.sessionId}/images/${imageHash(png)}`);
    expect(steered.images[0].mediaType).toBe("image/png");

    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${client.sessionId}/images/${imageHash(png)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.toString("base64")).toBe(png);

    const stored = chatHistoryManager.load(client.sessionId) as { images?: { data?: string }[] }[];
    expect(stored.some((m) => m.images?.some((i) => i.data === png))).toBe(true);

    client.close();
  });

  it("re-queues a rejected steer instead of dropping it (Codex turn/steer rejection, docs/140)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "First message", sessionId: client.sessionId });
    const claude = await waitForClaude(() => lastClaude);
    claude.initSession("steer-reject-session");

    client.send({ type: "send_message", text: "Steer me", sessionId: client.sessionId });
    await drainUntil(client, (m) => m.type === "message_steered");

    const runner = (app as any).runnerRegistry.get(client.sessionId);
    expect(runner.steeredMessages.length).toBe(1);

    claude.emit("event", { type: "agent_steer_rejected", text: "Steer me" });

    const queued = await drainUntil(client, (m) => m.type === "message_queued");
    expect(queued).toMatchObject({ type: "message_queued", text: "Steer me" });

    expect(runner.steeredMessages.length).toBe(0);
    expect(runner.messageQueue.map((m: { text: string }) => m.text)).toContain("Steer me");

    client.close();
  });

  it("re-queues a steer the CLI never acknowledged so it runs as the next turn (turn-end gap, docs/140)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Build the thing", sessionId: client.sessionId });
    const claude = await waitForClaude(() => lastClaude);
    claude.initSession("steer-gap-session");

    client.send({ type: "send_message", text: "fix the typo too", sessionId: client.sessionId });
    await drainUntil(client, (m) => m.type === "message_steered");

    const runner = (app as any).runnerRegistry.get(client.sessionId);
    expect(runner.steeredMessages.length).toBe(1);
    expect(runner.steeredMessages[0].assembledPrompt).toBe("fix the typo too");

    claude.emit("event", { type: "result", subtype: "success", session_id: "steer-gap-session" });

    const queued = await drainUntil(client, (m) => m.type === "message_queued");
    expect(queued).toMatchObject({ type: "message_queued", text: "fix the typo too" });

    expect(runner.steeredMessages.length).toBe(0);
    for (let i = 0; i < 50 && claude.stdinData.filter((d: string) => d.includes("fix the typo too")).length < 2; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const resends = claude.stdinData.filter((d: string) => d.includes("fix the typo too"));
    expect(resends.length).toBeGreaterThanOrEqual(2);

    client.close();
  });

  it("does NOT re-queue a steer the CLI acknowledged via replay echo (docs/140)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Build the thing", sessionId: client.sessionId });
    const claude = await waitForClaude(() => lastClaude);
    claude.initSession("steer-ack-session");

    client.send({ type: "send_message", text: "acknowledged steer", sessionId: client.sessionId });
    await drainUntil(client, (m) => m.type === "message_steered");

    const runner = (app as any).runnerRegistry.get(client.sessionId);
    const echoText = runner.steeredMessages[0].assembledPrompt as string;

    claude.emit("event", {
      type: "user",
      isReplay: true,
      message: { content: [{ type: "text", text: echoText }] },
    });
    expect(runner.steeredMessages[0].delivered).toBe(true);

    claude.emit("event", { type: "result", subtype: "success", session_id: "steer-ack-session" });

    const after = await client.drain();
    expect(after.some((m) => m.type === "message_queued")).toBe(false);
    expect(after.some((m) => m.type === "session_status" && (m as AnyMsg).running === false)).toBe(true);

    const history = chatHistoryManager.load(client.sessionId);
    const userTexts = history.filter((m) => m.role === "user").map((m) => m.text);
    expect(userTexts.filter((t) => t === "acknowledged steer").length).toBe(1);

    client.close();
  });

  it("runs the post-turn flow (session_agent_finished, queue drain) on agent_result without waiting for done — streaming path", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Turn one" });
    const claude = await waitForClaude(() => lastClaude);
    claude.initSession("steer-session-2");

    claude.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "steer-session-2",
      duration_ms: 100,
    });

    const status = await drainUntil(client, (m) => m.type === "session_status" && (m as AnyMsg).running === false);
    expect(status).toMatchObject({ type: "session_status", running: false });

    expect(claude.killed).toBe(false);

    client.close();
  });

  it("persists a steered message at its true transcript position, not collapsed up next to the turn's first user message (docs/140)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Implement monsters", sessionId: client.sessionId });
    const claude = await waitForClaude(() => lastClaude);
    claude.initSession("steer-order-session");

    claude.emit("event", {
      type: "assistant",
      message: { content: [
        { type: "text", text: "Adding goblins" },
        { type: "tool_use", id: "tu-1", name: "Write", input: {} },
      ] },
    });
    claude.emit("event", {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tu-1", content: "ok" }] },
    });

    client.send({ type: "send_message", text: "no, bullet pierce", sessionId: client.sessionId });
    const steered = await drainUntil(client, (m) => m.type === "message_steered");
    expect(steered).toMatchObject({ type: "message_steered", text: "no, bullet pierce" });

    claude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "Adding bullet pierce" }] },
    });
    claude.emit("event", { type: "result", subtype: "success", session_id: "steer-order-session" });

    await drainUntil(client, (m) => m.type === "session_status" && (m as AnyMsg).running === false);

    const history = chatHistoryManager.load(client.sessionId);
    const shape = history.map((m) => ({ role: m.role, text: m.text }));
    expect(shape).toEqual([
      { role: "user", text: "Implement monsters" },
      { role: "assistant", text: "Adding goblins" },
      { role: "user", text: "no, bullet pierce" },
      { role: "assistant", text: "Adding bullet pierce" },
    ]);

    client.close();
  });

  it("adopts the turn the CLI runs for a steer it acked too late to apply (docs/140)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Do the first thing", sessionId: client.sessionId });
    const claude = await waitForClaude(() => lastClaude);
    claude.initSession("late-steer-session");

    claude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "First thing done" }] },
    });

    client.send({ type: "send_message", text: "now rename the folder", sessionId: client.sessionId });
    await drainUntil(client, (m) => m.type === "message_steered");
    const runner = (app as any).runnerRegistry.get(client.sessionId);
    const echoText = runner.steeredMessages[0].assembledPrompt as string;
    claude.emit("event", {
      type: "user",
      isReplay: true,
      message: { content: [{ type: "text", text: echoText }] },
    });
    expect(runner.steeredMessages[0].delivered).toBe(true);

    claude.emit("event", { type: "result", subtype: "success", session_id: "late-steer-session" });
    await drainUntil(client, (m) => m.type === "session_status" && (m as AnyMsg).running === false);
    expect(runner.running).toBe(false);

    // init also follows mode changes, so only model output establishes a new turn.
    claude.initSession("late-steer-session");
    await new Promise((r) => setTimeout(r, 100));
    expect(runner.running).toBe(false);

    claude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "Renamed the folder" }] },
    });
    const busy = await drainUntil(client, (m) => m.type === "session_status" && (m as AnyMsg).running === true);
    expect(busy).toMatchObject({ type: "session_status", running: true });
    expect(runner.running).toBe(true);
    expect(runner.chatMessageGroups.map((g: AnyMsg) => g.text)).toEqual(["Renamed the folder"]);

    claude.emit("event", { type: "result", subtype: "success", session_id: "late-steer-session" });
    await drainUntil(client, (m) => m.type === "session_status" && (m as AnyMsg).running === false);

    const shape = chatHistoryManager.load(client.sessionId).map((m) => ({ role: m.role, text: m.text }));
    expect(shape).toEqual([
      { role: "user", text: "Do the first thing" },
      { role: "assistant", text: "First thing done" },
      { role: "user", text: "now rename the folder" },
      { role: "assistant", text: "Renamed the folder" },
    ]);

    client.close();
  });

  it("reuses the persistent streaming agent for the next top-level turn (no new process, no SIGTERM)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Turn one" });
    const claude1 = await waitForClaude(() => lastClaude);
    claude1.initSession("reuse-session");
    expect(claude1.runCalled).toBe(true);
    expect(claude1.lastUseStreaming).toBe(true);

    claude1.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "reuse-session",
      duration_ms: 100,
    });
    await drainUntil(client, (m) => m.type === "session_status" && (m as AnyMsg).running === false);

    expect(claude1.killed).toBe(false);

    client.send({ type: "send_message", text: "Turn two" });

    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const check = (): void => {
        if (claude1.stdinData.some((d) => d.includes("Turn two"))) {
          resolve();
          return;
        }
        if (Date.now() - start > 2000) {
          reject(new Error("Turn two was never delivered via sendUserMessage"));
          return;
        }
        setTimeout(check, 10);
      };
      check();
    });

    expect(lastClaude).toBe(claude1);
    expect(claude1.killed).toBe(false);
    // runCalled is a latch; lastPrompt detects a second run with the new prompt.
    expect(claude1.lastPrompt).toBe("Turn one");

    client.close();
  });

  it("pushes setPermissionMode on the persistent agent when the user toggles modes between turns (docs/138)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Plan it", permissionMode: "plan" });
    const claude = await waitForClaude(() => lastClaude);
    claude.initSession("mode-toggle-session");
    expect(claude.runCalled).toBe(true);
    expect(claude.lastPermissionMode).toBe("plan");
    expect(claude.permissionModeCalls).toEqual([]);

    claude.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "mode-toggle-session",
      duration_ms: 100,
    });
    await drainUntil(client, (m) => m.type === "session_status" && (m as AnyMsg).running === false);

    client.send({ type: "send_message", text: "Now do it" });

    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const check = (): void => {
        if (claude.stdinData.some((d) => d.includes("Now do it"))) {
          resolve();
          return;
        }
        if (Date.now() - start > 2000) {
          reject(new Error("Turn 2 message was never delivered"));
          return;
        }
        setTimeout(check, 10);
      };
      check();
    });

    expect(claude.permissionModeCalls).toEqual([undefined]);
    expect(claude.killed).toBe(false);
    expect(claude.lastPrompt).toBe("Plan it");

    client.close();
  });

  it("respawns the persistent agent on the newly picked model instead of steering into the old one", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "set_model", model: "claude-fable-5-1" });
    client.send({ type: "send_message", text: "Turn one" });
    const claude1 = await waitForClaude(() => lastClaude);
    claude1.initSession("model-switch-session");
    expect(claude1.lastModel).toBe("claude-fable-5-1");

    claude1.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "model-switch-session",
      duration_ms: 100,
    });
    await drainUntil(client, (m) => m.type === "session_status" && (m as AnyMsg).running === false);
    expect(claude1.killed).toBe(false);

    client.send({ type: "set_model", model: "claude-opus-5" });
    client.send({ type: "send_message", text: "Turn two" });

    const claude2 = await waitForClaude(() => lastClaude, claude1);
    expect(claude2.lastModel).toBe("claude-opus-5");
    expect(claude2.lastPrompt).toContain("Turn two");
    expect(claude1.killed).toBe(true);
    expect(claude1.stdinData.some((d) => d.includes("Turn two"))).toBe(false);

    client.close();
  });

  it("keeps reusing the persistent agent when the model has NOT changed", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "set_model", model: "claude-fable-5-1" });
    client.send({ type: "send_message", text: "Turn one" });
    const claude1 = await waitForClaude(() => lastClaude);
    claude1.initSession("model-same-session");

    claude1.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "model-same-session",
      duration_ms: 100,
    });
    await drainUntil(client, (m) => m.type === "session_status" && (m as AnyMsg).running === false);

    client.send({ type: "set_model", model: "claude-fable-5-1" });
    client.send({ type: "send_message", text: "Turn two" });

    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const check = (): void => {
        if (claude1.stdinData.some((d) => d.includes("Turn two"))) { resolve(); return; }
        if (Date.now() - start > 2000) { reject(new Error("Turn two was never steered into the resident process")); return; }
        setTimeout(check, 10);
      };
      check();
    });
    expect(lastClaude).toBe(claude1);
    expect(claude1.killed).toBe(false);

    client.close();
  });

  it("does NOT push setPermissionMode when the requested mode matches what's already applied (docs/138)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Turn one", permissionMode: "plan" });
    const claude = await waitForClaude(() => lastClaude);
    claude.initSession("mode-stable-session");
    expect(claude.lastPermissionMode).toBe("plan");

    claude.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "mode-stable-session",
      duration_ms: 100,
    });
    await drainUntil(client, (m) => m.type === "session_status" && (m as AnyMsg).running === false);

    client.send({ type: "send_message", text: "Turn two", permissionMode: "plan" });

    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const check = (): void => {
        if (claude.stdinData.some((d) => d.includes("Turn two"))) {
          resolve();
          return;
        }
        if (Date.now() - start > 2000) {
          reject(new Error("Turn 2 message was never delivered"));
          return;
        }
        setTimeout(check, 10);
      };
      check();
    });

    expect(claude.permissionModeCalls).toEqual([]);

    client.close();
  });

  it("resyncs appliedPermissionMode from init.permissionMode so a drifted streaming session can still leave plan mode (plan-desync fix)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Plan it", permissionMode: "plan" });
    const claude = await waitForClaude(() => lastClaude);
    claude.initSession("plan-desync-session");
    expect(claude.lastPermissionMode).toBe("plan");

    const runner = (app as any).runnerRegistry.get(client.sessionId);
    expect(runner).toBeTruthy();
    expect(runner.appliedPermissionMode).toBe("plan");

    claude.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "plan-desync-session",
      duration_ms: 100,
    });
    await drainUntil(client, (m) => m.type === "session_status" && (m as AnyMsg).running === false);

    runner.appliedPermissionMode = undefined;

    claude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "plan-desync-session",
      permissionMode: "plan",
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(runner.appliedPermissionMode).toBe("plan");

    client.send({ type: "send_message", text: "Now execute it" });

    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const check = (): void => {
        if (claude.stdinData.some((d) => d.includes("Now execute it"))) { resolve(); return; }
        if (Date.now() - start > 2000) { reject(new Error("Turn 2 message never delivered")); return; }
        setTimeout(check, 10);
      };
      check();
    });

    expect(claude.permissionModeCalls).toEqual([undefined]);
    expect(claude.killed).toBe(false);

    client.close();
  });

  it("pushes setPermissionMode before a steered message that changes the mode (plan → auto, plan-approval fix)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Plan it", permissionMode: "plan" });
    const claude = await waitForClaude(() => lastClaude);
    claude.initSession("steer-mode-change-session");
    expect(claude.lastPermissionMode).toBe("plan");
    expect(claude.permissionModeCalls).toEqual([]);

    client.send({ type: "send_message", text: "Execute the plan you just described." });
    const steered = await drainUntil(client, (m) => m.type === "message_steered");
    expect(steered).toMatchObject({ type: "message_steered", text: "Execute the plan you just described." });

    expect(claude.stdinData).toContain("Execute the plan you just described.");
    expect(claude.permissionModeCalls).toEqual([undefined]);
    expect(claude.killed).toBe(false);

    client.close();
  });

  it("tracks autonomous EnterPlanMode so accepting the plan can release the streaming process", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Plan if needed" });
    const claude = await waitForClaude(() => lastClaude);
    claude.initSession("autonomous-plan-session");
    expect(claude.lastPermissionMode).toBeUndefined();
    expect(claude.permissionModeCalls).toEqual([]);

    claude.emit("event", {
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: "enter-plan-1",
          name: "EnterPlanMode",
          input: {},
        }],
      },
    });

    await new Promise((r) => setTimeout(r, 30));

    client.send({ type: "send_message", text: "Execute the plan you just described." });
    const steered = await drainUntil(client, (m) => m.type === "message_steered");
    expect(steered).toMatchObject({ type: "message_steered", text: "Execute the plan you just described." });

    expect(claude.stdinData).toContain("Execute the plan you just described.");
    expect(claude.permissionModeCalls).toEqual([undefined]);
    expect(claude.killed).toBe(false);

    client.close();
  });

  it("does NOT push setPermissionMode for a steered message when the mode is unchanged", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "First message" });
    const claude = await waitForClaude(() => lastClaude);
    claude.initSession("steer-mode-stable-session");
    expect(claude.permissionModeCalls).toEqual([]);

    client.send({ type: "send_message", text: "Steer me" });
    const steered = await drainUntil(client, (m) => m.type === "message_steered");
    expect(steered).toMatchObject({ type: "message_steered", text: "Steer me" });

    expect(claude.stdinData).toContain("Steer me");
    expect(claude.permissionModeCalls).toEqual([]);

    client.close();
  });

  it("interrupts the agent when it emits an ExitPlanMode tool_use under live steering", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Plan it", permissionMode: "plan" });
    const claude = await waitForClaude(() => lastClaude);
    expect(claude.lastUseStreaming).toBe(true);
    claude.initSession("plan-interrupt-session");
    expect(claude.interrupted).toBe(false);

    claude.emit("event", {
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: "exit-1",
          name: "ExitPlanMode",
          input: { plan: "Step 1: do the thing" },
        }],
      },
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(claude.interrupted).toBe(true);

    client.close();
  });

  it("suppresses the CLI's auto-resolved tool_result for an interrupted ExitPlanMode", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Plan it", permissionMode: "plan" });
    const claude = await waitForClaude(() => lastClaude);
    claude.initSession("plan-suppress-session");

    claude.emit("event", {
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: "exit-suppress-1",
          name: "ExitPlanMode",
          input: { plan: "Step 1: do the thing" },
        }],
      },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(claude.interrupted).toBe(true);

    claude.emit("event", {
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "exit-suppress-1",
          content: "Plan mode exit not approved — auto-resolved by CLI",
          is_error: true,
        }],
      },
    });

    let sawSuppressedResult = false;
    const deadline = Date.now() + 200;
    while (Date.now() < deadline) {
      let msg: AnyMsg;
      try {
        msg = await client.receive(80);
      } catch {
        break;
      }
      if (msg.type === "agent_event") {
        const event = (msg as { event: { type: string; content?: unknown[] } }).event;
        if (event.type === "agent_tool_result") {
          const hasId = (event.content ?? []).some((b) => {
            const id = (b as { tool_use_id?: string }).tool_use_id;
            return id === "exit-suppress-1";
          });
          if (hasId) sawSuppressedResult = true;
        }
      }
    }
    expect(sawSuppressedResult).toBe(false);

    client.close();
  });

  it("does NOT interrupt on ExitPlanMode when liveSteering is off (one-shot path renders the card naturally)", async () => {
    credentialStore.setLiveSteering(false);

    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Plan it", permissionMode: "plan" });
    const claude = await waitForClaude(() => lastClaude);
    expect(claude.lastUseStreaming).toBeFalsy();

    claude.emit("event", {
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: "exit-oneshot-1",
          name: "ExitPlanMode",
          input: { plan: "Step 1: do the thing" },
        }],
      },
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(claude.interrupted).toBe(false);

    client.close();
  });

  it("steers a programmatic dispatch (shipit session message / child message) mid-turn instead of queuing it (docs/163)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "First message", sessionId: client.sessionId });
    const claude = await waitForClaude(() => lastClaude);
    claude.initSession("dispatch-steer-session");
    expect(claude.lastUseStreaming).toBe(true);

    const runner = (app as any).runnerRegistry.get(client.sessionId);
    expect(runner).toBeTruthy();
    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const check = (): void => {
        if (runner.running && runner.isStreamingActive && runner.getAgent()) { resolve(); return; }
        if (Date.now() - start > 2000) { reject(new Error("runner never became running+streaming")); return; }
        setTimeout(check, 10);
      };
      check();
    });

    runner.dispatch(testDispatch({
      text: "Programmatic steer",
      messageOrigin: { sessionId: "parent", sessionTitle: "Parent", relation: "parent" },
    }));

    const steered = await drainUntil(client, (m) => m.type === "message_steered");
    expect(steered).toMatchObject({ type: "message_steered", text: "Programmatic steer" });
    expect(claude.stdinData.some((input) => input.includes("Programmatic steer"))).toBe(true);
    expect(claude.stdinData.some((input) => input.includes('Agent message from PARENT session "Parent" (parent)'))).toBe(true);
    expect(runner.queueLength).toBe(0);

    client.close();
  });

  it("starts a DISPATCHED first turn (spawned child / quick session) as a streaming process so a follow-up dispatch steers instead of queuing (docs/163)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    const runner = await new Promise<AnyMsg>((resolve, reject) => {
      const start = Date.now();
      const check = (): void => {
        const r = (app as AnyMsg).runnerRegistry.get(client.sessionId);
        if (r) { resolve(r); return; }
        if (Date.now() - start > 2000) { reject(new Error("runner was never created on connect")); return; }
        setTimeout(check, 10);
      };
      check();
    });

    runner.dispatch(testDispatch({ text: "Build the initial thing" }));
    const claude = await waitForClaude(() => lastClaude);
    expect(claude.lastUseStreaming).toBe(true);
    claude.initSession("dispatched-first-turn-session");

    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const check = (): void => {
        if (runner.running && runner.isStreamingActive && runner.getAgent()) { resolve(); return; }
        if (Date.now() - start > 2000) { reject(new Error("dispatched turn never became running+streaming")); return; }
        setTimeout(check, 10);
      };
      check();
    });

    runner.dispatch(testDispatch({ text: "Also handle the edge case" }));

    const steered = await drainUntil(client, (m) => m.type === "message_steered");
    expect(steered).toMatchObject({ type: "message_steered", text: "Also handle the edge case" });
    expect(claude.stdinData).toContain("Also handle the edge case");
    expect(runner.queueLength).toBe(0);

    client.close();
  });

  it("reuses a RESIDENT streaming process for a follow-up dispatch even when useStreaming recomputes false — never spawns a competing one-shot (docs/146 prod race)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "First message" });
    const claude1 = await waitForClaude(() => lastClaude);
    claude1.initSession("resident-reuse-session");
    expect(claude1.lastUseStreaming).toBe(true);

    const runner = (app as any).runnerRegistry.get(client.sessionId);
    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const check = (): void => {
        if (runner.running && runner.isStreamingActive && runner.getAgent()) { resolve(); return; }
        if (Date.now() - start > 2000) { reject(new Error("turn 1 never became running+streaming")); return; }
        setTimeout(check, 10);
      };
      check();
    });

    claude1.emit("event", { type: "result", subtype: "success", session_id: "resident-reuse-session" });
    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const check = (): void => {
        if (!runner.running && runner.isStreamingActive && runner.getAgent()) { resolve(); return; }
        if (Date.now() - start > 2000) { reject(new Error("turn 1 never settled to resident-idle")); return; }
        setTimeout(check, 10);
      };
      check();
    });

    credentialStore.setLiveSteering(false);

    runner.dispatch(testDispatch({ text: "Second turn instruction" }));

    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const check = (): void => {
        if (claude1.stdinData.includes("Second turn instruction")) { resolve(); return; }
        if (Date.now() - start > 2000) { reject(new Error("follow-up was not delivered via sendUserMessage")); return; }
        setTimeout(check, 10);
      };
      check();
    });
    expect(lastClaude).toBe(claude1);
    expect(runner.getAgent()).toBe(claude1);
    expect(runner.queueLength).toBe(0);

    client.close();
  });

  it("delivers a dispatch-queued message at turn end even when the streaming process exits WITHOUT an agent_result (never-delivered fix, docs/162)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "First message", sessionId: client.sessionId });
    const claude1 = await waitForClaude(() => lastClaude);
    claude1.initSession("drain-on-done-session");
    expect(claude1.lastUseStreaming).toBe(true);

    const runner = (app as any).runnerRegistry.get(client.sessionId);
    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const check = (): void => {
        if (runner.running && runner.isStreamingActive) { resolve(); return; }
        if (Date.now() - start > 2000) { reject(new Error("runner never became running+streaming")); return; }
        setTimeout(check, 10);
      };
      check();
    });

    credentialStore.setLiveSteering(false);
    runner.dispatch(testDispatch({ text: "Queued during turn" }));
    const queued = await drainUntil(client, (m) => m.type === "message_queued");
    expect(queued).toMatchObject({ type: "message_queued", text: "Queued during turn" });

    claude1.emit("done", 1);

    const claude2 = await waitForClaude(() => lastClaude, claude1);
    expect(claude2).not.toBe(claude1);
    expect(claude2.runCalled).toBe(true);
    expect(claude2.lastPrompt).toContain("Queued during turn");

    client.close();
  });

  it("falls back to the queue path when liveSteering is off, even if the agent supports steering", async () => {
    credentialStore.setLiveSteering(false);

    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "First" });
    const claude = await waitForClaude(() => lastClaude);
    claude.initSession("queue-session");

    client.send({ type: "send_message", text: "Second" });

    const queued = await drainUntil(client, (m) => m.type === "message_queued");
    expect(queued).toMatchObject({ type: "message_queued", text: "Second" });

    expect(claude.stdinData).not.toContain("Second");

    expect((claude as any).lastUseStreaming).toBeFalsy();

    client.close();
  });
});
