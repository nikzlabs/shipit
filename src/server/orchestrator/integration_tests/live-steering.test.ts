/**
 * Integration tests for live steering (docs/140).
 *
 * Live steering lets the user inject a message while the agent is mid-turn,
 * routed through `AgentProcess.sendUserMessage()` rather than the per-turn
 * queue. Only active when:
 *   1. The active agent's `capabilities.supportsSteering` is true (claude/codex), AND
 *   2. The user has flipped `liveSteering` on in settings.
 *
 * The streaming path also changes the post-turn lifecycle: the agent process
 * is persistent across turns, so `done` only fires on dispose/crash —
 * post-turn work (queue drain, `session_agent_finished`, auto-commit) must
 * hang off `agent_result` instead. These tests pin both contracts.
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
    // Flip live steering on for every test in this suite. The agent registry's
    // default `supportsSteering: true` for claude takes care of the capability
    // side, so this is the only switch the user touches.
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

  /** Drain messages until predicate returns truthy, up to maxMsgs attempts. */
  async function drainUntil(client: TestClient, predicate: (m: AnyMsg) => boolean, maxMsgs = 30, timeoutMs = 2000): Promise<AnyMsg> {
    for (let i = 0; i < maxMsgs; i++) {
      const msg: AnyMsg = await client.receive(timeoutMs);
      if (predicate(msg)) return msg;
    }
    return null;
  }

  it("starts the agent with useStreaming=true when liveSteering is on and agent supports it", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "Hello" });
    const claude = await waitForClaude(() => lastClaude);
    // The orchestrator computes useStreaming from registry.supportsSteering
    // AND credentialStore.liveSteering — both true here.
    expect((claude as any).lastUseStreaming).toBe(true);

    client.close();
  });

  it("steers a mid-turn message via sendUserMessage and emits message_steered (not message_queued)", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // First turn — kick off the (faked) streaming agent.
    client.send({ type: "send_message", text: "First message" });
    const claude = await waitForClaude(() => lastClaude);
    claude.initSession("steer-session-1");

    // The orchestrator marks the runner as running once the agent factory has
    // returned; the next send arrives mid-turn.
    client.send({ type: "send_message", text: "Steer me" });

    // The steered message should NOT be queued — it should arrive as
    // `message_steered` on the WS and as a `sendUserMessage()` call on the
    // agent.
    const steered = await drainUntil(client, (m) => m.type === "message_steered");
    expect(steered).toMatchObject({ type: "message_steered", text: "Steer me" });

    // The fake adapter records sendUserMessage calls under `stdinData`
    // (its default `sendUserMessage` proxies to `writeStdin` for parity with
    // production adapters).
    expect(claude.stdinData).toContain("Steer me");

    client.close();
  });

  it("runs the post-turn flow (session_agent_finished, queue drain) on agent_result without waiting for done — streaming path", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Turn 1: start the streaming agent.
    client.send({ type: "send_message", text: "Turn one" });
    const claude = await waitForClaude(() => lastClaude);
    claude.initSession("steer-session-2");

    // Emit `agent_result` WITHOUT a follow-up `done`. In streaming mode the
    // process is persistent — the turn ends on `result`, the process stays
    // alive. The orchestrator's streaming path must trigger post-turn work
    // (session_status running=false) here, not wait for a process exit that
    // never comes.
    claude.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "steer-session-2",
      duration_ms: 100,
    });

    // session_status flips to running:false on the result event.
    const status = await drainUntil(client, (m) => m.type === "session_status" && (m as AnyMsg).running === false);
    expect(status).toMatchObject({ type: "session_status", running: false });

    // The agent process was NOT killed — for a streaming agent, `done`
    // belongs to dispose, not to the per-turn lifecycle.
    expect(claude.killed).toBe(false);

    client.close();
  });

  it("persists a steered message at its true transcript position, not collapsed up next to the turn's first user message (docs/140)", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Turn opens with the user's first message.
    client.send({ type: "send_message", text: "Implement monsters", sessionId: client.sessionId });
    const claude = await waitForClaude(() => lastClaude);
    claude.initSession("steer-order-session");

    // First assistant group: text + a tool call, then its tool result. The
    // tool result closes the group (needsNewMessageGroup) and persists it as
    // in-progress.
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

    // Steer mid-turn — exactly one assistant group exists at this point, so the
    // steer must land AFTER it (index 2 overall), not next to the first user
    // message (index 1).
    client.send({ type: "send_message", text: "no, bullet pierce", sessionId: client.sessionId });
    const steered = await drainUntil(client, (m) => m.type === "message_steered");
    expect(steered).toMatchObject({ type: "message_steered", text: "no, bullet pierce" });

    // Second assistant group responds to the steer, then the turn ends.
    claude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "Adding bullet pierce" }] },
    });
    claude.emit("event", { type: "result", subtype: "success", session_id: "steer-order-session" });

    // Wait for the turn to finalize before reading persisted history.
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

  it("reuses the persistent streaming agent for the next top-level turn (no new process, no SIGTERM)", async () => {
    // Regression: under live steering the orchestrator USED TO clear the
    // runner's agent reference on `agent_result`, so the next top-level
    // send_message spawned a brand-new agent process. For container sessions
    // the worker still held the previous streaming process, so the new
    // `/agent/start` 409'd, the orchestrator fell back to `/agent/kill`
    // (SIGTERM → exit 143) + `/agent/start`, and the user saw multiple
    // "Agent process started" entries plus mid-turn-looking exit-143 errors.
    //
    // The fix keeps the agent reference across turns and feeds the next
    // top-level message in via `sendUserMessage` instead of `run()`.
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Turn 1: spawn the streaming agent via run().
    client.send({ type: "send_message", text: "Turn one" });
    const claude1 = await waitForClaude(() => lastClaude);
    claude1.initSession("reuse-session");
    expect(claude1.runCalled).toBe(true);
    expect(claude1.lastUseStreaming).toBe(true);

    // End turn 1 — process stays alive (streaming).
    claude1.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "reuse-session",
      duration_ms: 100,
    });
    await drainUntil(client, (m) => m.type === "session_status" && (m as AnyMsg).running === false);

    // Crucial invariants before turn 2:
    //  - agent ref is preserved on the runner (basis for reuse),
    //  - the process was NOT killed by the agent_result handler.
    expect(claude1.killed).toBe(false);

    // Turn 2: another top-level send_message. With the fix, this must reuse
    // claude1 (no new factory call) and deliver "Turn two" via sendUserMessage.
    client.send({ type: "send_message", text: "Turn two" });

    // Wait for sendUserMessage to land — the fake's default sendUserMessage
    // proxies to writeStdin, so stdinData picks up the turn-2 prompt.
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

    // Same process, no kill, no fresh factory spawn.
    expect(lastClaude).toBe(claude1);
    expect(claude1.killed).toBe(false);
    // run() must NOT have been called a second time — the fake's `runCalled`
    // is a one-way latch, so we assert the lastPrompt didn't get clobbered
    // by a second run({prompt: "Turn two"}) call. Turn 1's prompt should
    // still be sitting there.
    expect(claude1.lastPrompt).toBe("Turn one");

    client.close();
  });

  it("pushes setPermissionMode on the persistent agent when the user toggles modes between turns (docs/138)", async () => {
    // Regression: the streaming CLI keeps its spawn-time `--permission-mode`
    // for life. Toggling the chip used to update the UI / settings store but
    // never reach the CLI, so plan → auto (or back) silently didn't take
    // effect. The fix pushes a `set_permission_mode` control_request on the
    // existingAgent before the next sendUserMessage.
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Turn 1: open in plan mode → spawn with permissionMode "plan".
    client.send({ type: "send_message", text: "Plan it", permissionMode: "plan" });
    const claude = await waitForClaude(() => lastClaude);
    claude.initSession("mode-toggle-session");
    expect(claude.runCalled).toBe(true);
    expect(claude.lastPermissionMode).toBe("plan");
    // No mid-stream mode change yet — the spawn flag carries the initial mode.
    expect(claude.permissionModeCalls).toEqual([]);

    // End turn 1 — process stays alive (streaming).
    claude.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "mode-toggle-session",
      duration_ms: 100,
    });
    await drainUntil(client, (m) => m.type === "session_status" && (m as AnyMsg).running === false);

    // Turn 2: user toggled back to auto (the WS message omits permissionMode).
    // The orchestrator MUST push a setPermissionMode(undefined) before
    // sendUserMessage so the persistent CLI actually leaves plan mode.
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

    // setPermissionMode(undefined) — exactly one call, mapping ShipIt "auto"
    // back to the CLI's no-flag default.
    expect(claude.permissionModeCalls).toEqual([undefined]);
    // Same process — no respawn, no kill.
    expect(claude.killed).toBe(false);
    expect(claude.lastPrompt).toBe("Plan it");

    client.close();
  });

  it("does NOT push setPermissionMode when the requested mode matches what's already applied (docs/138)", async () => {
    // The mismatch check exists so we don't spam the CLI with redundant
    // control_requests when the user just clicks Send twice in the same mode.
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

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

    // Turn 2: same plan mode — no control_request needed.
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

  it("falls back to the queue path when liveSteering is off, even if the agent supports steering", async () => {
    // Flip the setting off for this test only.
    credentialStore.setLiveSteering(false);

    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "First" });
    const claude = await waitForClaude(() => lastClaude);
    claude.initSession("queue-session");

    client.send({ type: "send_message", text: "Second" });

    // With steering off, the second message must be queued — not steered.
    const queued = await drainUntil(client, (m) => m.type === "message_queued");
    expect(queued).toMatchObject({ type: "message_queued", text: "Second" });

    // And sendUserMessage was NOT called for the queued text (only writeStdin
    // would record it; the fake's writeStdin captures both writeStdin and
    // sendUserMessage calls, so just verify the queued message wasn't
    // delivered to the running agent).
    expect(claude.stdinData).not.toContain("Second");

    // The agent's useStreaming flag should be false here too.
    expect((claude as any).lastUseStreaming).toBeFalsy();

    client.close();
  });
});
