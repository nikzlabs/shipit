/**
 * Integration tests for prompt queuing (feature 020).
 *
 * When Claude is running and a new send_message arrives, the server queues it
 * and sends message_queued. When Claude finishes, the next message is dequeued
 * and executed automatically.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Spy on `finalizeSessionAgentEnvironment` so the SSE-drop regression test
// below can assert sync-back fires on `agent_result` even when `agent_done`
// is missed. Wraps importOriginal so the real implementation still runs —
// the test only observes invocation count and arguments.
const finalizeAgentEnvSpy = vi.fn();
vi.mock("../session-agent-env.js", async (importOriginal) => {
  const mod = await importOriginal() as Record<string, unknown>;
  const real = mod.finalizeSessionAgentEnvironment as (...args: unknown[]) => void;
  return {
    ...mod,
    finalizeSessionAgentEnvironment: (...args: unknown[]) => {
      finalizeAgentEnvSpy(...args);
      return real(...args);
    },
  };
});

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

type AnyMsg = any;

describe("Integration: prompt queuing", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let chatHistoryManager: ChatHistoryManager;
  let lastClaude: FakeClaudeProcess = null as any;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-queue-"));

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

  it("queues a second message while the first is running and returns message_queued", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Send first message — starts Claude
    client.send({ type: "send_message", text: "First message" });
    const firstClaude = await waitForClaude(() => lastClaude);
    expect(firstClaude.lastPrompt).toBe("First message");

    // Send second message while Claude is running — should be queued
    client.send({ type: "send_message", text: "Second message" });

    const queued = await drainUntil(client, (m) => m.type === "message_queued");

    expect(queued).toMatchObject({
      type: "message_queued",
      position: 1,
      text: "Second message",
    });

    // The second Claude process should NOT have been started yet
    expect(lastClaude).toBe(firstClaude);

    client.close();
  });

  // docs/142 (B1): an auth failure mid-turn must tear the turn down — kill the
  // agent and clear running state — so the next send isn't blocked by a stale
  // agent. A persistent streaming agent doesn't exit on its own, so without
  // this the worker would keep "Agent already running".
  it("tears the turn down on auth_required (kills agent, clears running)", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "go" });
    const claude = await waitForClaude(() => lastClaude);
    claude.emit("event", { type: "agent_init", sessionId: "s-auth", model: "m", tools: [] });

    // The CLI hit an auth failure mid-turn.
    claude.emit("auth_required");

    // Client is told to re-auth, the agent is killed, and running is cleared.
    const authMsg = await drainUntil(client, (m) => m.type === "auth_required");
    expect(authMsg?.type).toBe("auth_required");
    expect(claude.killed).toBe(true);
    const status = await drainUntil(client, (m) => m.type === "session_status");
    expect(status).toMatchObject({ type: "session_status", running: false });

    client.close();
  });

  it("dequeues and executes the next message after Claude finishes", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Send first message
    client.send({ type: "send_message", text: "First" });
    const firstClaude = await waitForClaude(() => lastClaude);

    // Init the first session so the server has an agentSessionId
    firstClaude.emit("event", {
      type: "agent_init",
      sessionId: "session-a",
      model: "claude-3-5-sonnet",
      tools: [],
    });

    // Send second message while Claude is busy
    client.send({ type: "send_message", text: "Second" });

    // Wait for message_queued
    const queued = await drainUntil(client, (m) => m.type === "message_queued");
    expect(queued?.type).toBe("message_queued");

    // Finish the first Claude run
    firstClaude.emit("event", { type: "agent_result", status: "success", sessionId: "session-a", durationMs: 100 });
    firstClaude.emit("done", 0);

    // A second ClaudeProcess should now be started for "Second"
    const secondClaude = await waitForClaude(() => lastClaude, firstClaude);
    expect(secondClaude.lastPrompt).toBe("Second");
    expect(secondClaude).not.toBe(firstClaude);

    // The client should have received a queue_updated with an empty queue
    const queueUpdated = await drainUntil(client, (m) => m.type === "queue_updated", 30, 3000);
    expect(queueUpdated).toMatchObject({ type: "queue_updated", queue: [] });

    client.close();
  });

  it("cancel_queued_message with position removes a specific item", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Start first Claude
    client.send({ type: "send_message", text: "First" });
    const firstClaude = await waitForClaude(() => lastClaude);

    // Queue two more messages
    client.send({ type: "send_message", text: "Second" });
    client.send({ type: "send_message", text: "Third" });

    // Drain until we see two message_queued events
    const queuedMsgs: AnyMsg[] = [];
    while (queuedMsgs.length < 2) {
      const msg: AnyMsg = await client.receive(2000);
      if (msg.type === "message_queued") queuedMsgs.push(msg);
    }
    expect(queuedMsgs).toHaveLength(2);

    // Cancel the first queued item (0-indexed position 0 = "Second")
    client.send({ type: "cancel_queued_message", position: 0 });

    // Should receive queue_updated with only "Third" remaining at position 1
    const update = await drainUntil(client, (m) => m.type === "queue_updated");
    expect(update).toMatchObject({
      type: "queue_updated",
      queue: [{ text: "Third", position: 1 }],
    });

    firstClaude.emit("event", { type: "agent_result", status: "success", sessionId: "s1", durationMs: 10 });
    firstClaude.emit("done", 0);

    // Only "Third" should be run next
    const secondClaude = await waitForClaude(() => lastClaude, firstClaude);
    expect(secondClaude.lastPrompt).toBe("Third");

    client.close();
  });

  it("cancel_queued_message with 'all' clears the entire queue", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "First" });
    const firstClaude = await waitForClaude(() => lastClaude);

    client.send({ type: "send_message", text: "Second" });
    client.send({ type: "send_message", text: "Third" });

    // Wait for both to be queued
    const queuedMsgs: AnyMsg[] = [];
    while (queuedMsgs.length < 2) {
      const msg: AnyMsg = await client.receive(2000);
      if (msg.type === "message_queued") queuedMsgs.push(msg);
    }

    // Clear all
    client.send({ type: "cancel_queued_message", position: "all" });

    const update = await drainUntil(client, (m) => m.type === "queue_updated");
    expect(update).toMatchObject({ type: "queue_updated", queue: [] });

    // When first Claude finishes, no second Claude should start
    const savedLastClaude = lastClaude;
    firstClaude.emit("event", { type: "agent_result", status: "success", sessionId: "s1", durationMs: 10 });
    firstClaude.emit("done", 0);

    // Wait a bit and verify no new Claude process was created
    await new Promise((r) => setTimeout(r, 100));
    expect(lastClaude).toBe(savedLastClaude);

    client.close();
  });

  it("error path: rejects invalid images immediately without queuing", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({
      type: "send_message",
      text: "Hello",
      images: [{ data: "not-valid-base64!!!", mediaType: "image/png" }],
    });

    const errorMsg = await drainUntil(client, (m) => m.type === "error");
    expect(errorMsg?.type).toBe("error");

    client.close();
  });

  it("queuing still works after a Claude error (done with non-zero code)", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "First" });
    const firstClaude = await waitForClaude(() => lastClaude);

    client.send({ type: "send_message", text: "Second after error" });

    // Wait for message_queued
    const queued = await drainUntil(client, (m) => m.type === "message_queued");
    expect(queued?.type).toBe("message_queued");

    // First Claude crashes (exit code 1, no result event)
    firstClaude.emit("done", 1);

    // Second Claude should still be started for the queued message
    const secondClaude = await waitForClaude(() => lastClaude, firstClaude);
    expect(secondClaude.lastPrompt).toBe("Second after error");

    client.close();
  });

  // Regression: when a queued message's agent fails to start (e.g. the worker
  // returns 409 "Agent already running" because the previous turn's cleanup
  // hadn't completed when /agent/start landed), the rest of the queue used
  // to be stranded forever. The fix drains the next message from the agent's
  // `error` handler too, not just from `done`.
  it("drains the remaining queue when a queued message's agent emits error", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "First" });
    const firstClaude = await waitForClaude(() => lastClaude);
    firstClaude.emit("event", { type: "agent_init", sessionId: "s-1", model: "claude-sonnet-4-6", tools: [] });

    // Queue two more messages
    client.send({ type: "send_message", text: "Second" });
    client.send({ type: "send_message", text: "Third" });

    // Wait for both message_queued events
    const queuedMsgs: AnyMsg[] = [];
    while (queuedMsgs.length < 2) {
      const msg: AnyMsg = await client.receive(2000);
      if (msg.type === "message_queued") queuedMsgs.push(msg);
    }
    expect(queuedMsgs).toHaveLength(2);

    // First Claude finishes normally → drain shifts "Second"
    firstClaude.emit("event", { type: "agent_result", status: "success", sessionId: "s-1", durationMs: 10 });
    firstClaude.emit("done", 0);

    // A second Claude is started for "Second"
    const secondClaude = await waitForClaude(() => lastClaude, firstClaude);
    expect(secondClaude.lastPrompt).toBe("Second");

    // Simulate the 409 race: the second agent fails to start.
    secondClaude.emit("error", new Error("Agent already running"));

    // The third queued message must still be drained — the queue should NOT
    // be stranded by the transient error.
    const thirdClaude = await waitForClaude(() => lastClaude, secondClaude);
    expect(thirdClaude.lastPrompt).toBe("Third");

    client.close();
  });

  // Regression: when `agent_done` is lost (e.g. an SSE drop at exactly the
  // wrong moment, between the worker emitting `agent_result` and `agent_done`)
  // the queue used to be stranded forever — the chip would show "1 message
  // queued" and the agent never picked it up. `agent_result` is the canonical
  // turn-ended signal; the drain must hang off it, not off the process-exit
  // `done` event.
  it("drains the queue on agent_result even when no agent_done arrives (SSE-drop resilience)", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "First" });
    const firstClaude = await waitForClaude(() => lastClaude);
    firstClaude.emit("event", { type: "agent_init", sessionId: "s-result-only", model: "claude-sonnet-4-6", tools: [] });

    client.send({ type: "send_message", text: "Second" });
    const queued = await drainUntil(client, (m) => m.type === "message_queued");
    expect(queued?.type).toBe("message_queued");

    // Emit ONLY agent_result, not done — simulates a missed agent_done SSE.
    firstClaude.emit("event", { type: "agent_result", status: "success", sessionId: "s-result-only", durationMs: 100 });

    // The queue must still be drained — a second Claude must start for "Second".
    const secondClaude = await waitForClaude(() => lastClaude, firstClaude);
    expect(secondClaude.lastPrompt).toBe("Second");

    client.close();
  });

  // Regression for the OAuth source-token rot bug: the post-turn token
  // sync-back used to fire only from `agent.on("done")`. When `agent_done`
  // was missed (same SSE-drop / worker-race hazard the drain regression
  // above protects against), a token the CLI just rotated stayed stranded
  // in the per-session credentials dir — the orchestrator's source
  // `.credentials.json` never advanced. Once the in-container rotation
  // invalidated the refresh token sitting in source, every newly-bootstrapped
  // session 401'd with "Invalid authentication credentials". Sync-back must
  // hang off `agent_result` (the canonical turn-end signal) too, idempotent
  // with the `done`-fired path. Diagnosed against prod 2026-05-23: source
  // mtime 08:51 while a per-session token at 19:21 carried the refreshed
  // credentials; the rotation never propagated back.
  it("syncs OAuth token back on agent_result even when no agent_done arrives (SSE-drop resilience)", async () => {
    finalizeAgentEnvSpy.mockClear();
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "Only message" });
    const claude = await waitForClaude(() => lastClaude);
    claude.emit("event", { type: "agent_init", sessionId: "s-token-sync", model: "claude-sonnet-4-6", tools: [] });

    // Emit ONLY agent_result, not done — simulates a missed agent_done SSE.
    claude.emit("event", { type: "agent_result", status: "success", sessionId: "s-token-sync", durationMs: 100 });

    // Give the listener a beat to fire (it's async via the trySyncTokenBack
    // -> finalizeSessionAgentEnvironment chain).
    await new Promise((r) => setTimeout(r, 50));

    // The sync-back path must have been invoked. In this in-process test
    // setup the runner isn't a ContainerSessionRunner, so the underlying
    // file write is a no-op — but the helper invocation is the observable
    // we care about: the listener wired on `agent_result` actually fires
    // sync-back, instead of waiting for an `agent_done` that may never
    // arrive.
    expect(finalizeAgentEnvSpy).toHaveBeenCalledTimes(1);

    // Now emit `agent_done` — sync-back must be idempotent and NOT fire
    // a second time. (The `postTurnTokenSyncFired` guard exists exactly so
    // the late-arriving `done` doesn't double-run the file ops.)
    claude.emit("done", 0);
    await new Promise((r) => setTimeout(r, 50));
    expect(finalizeAgentEnvSpy).toHaveBeenCalledTimes(1);

    client.close();
  });
});
