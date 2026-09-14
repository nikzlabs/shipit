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
import type { CredentialStore } from "../credential-store.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";
import { testDispatch } from "./dispatch-test-helpers.js";
import { TURN_COMPLETED } from "../turn-settlement.js";
import { releaseQueuedTurn } from "../queue-drain.js";

type AnyMsg = any;

const WAKE_TEXT = "Child PR #42 merged: child (child-id).";

describe("Integration: a dispatched system turn behind a real turn (planning#256/planning#257)", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let credentialStore: CredentialStore;
  let lastClaude: FakeClaudeProcess = null as never;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    lastClaude = null as never;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-system-turn-queue-"));
    credentialStore = createTestCredentialStore(tmpDir);

    app = await buildApp({
      credentialStore,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: new SessionManager(dbManager),
      chatHistoryManager: new ChatHistoryManager(dbManager),
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

  async function drainUntil(client: TestClient, predicate: (m: AnyMsg) => boolean, maxMsgs = 30, timeoutMs = 2000): Promise<AnyMsg> {
    for (let i = 0; i < maxMsgs; i++) {
      const msg: AnyMsg = await client.receive(timeoutMs);
      if (predicate(msg)) return msg;
    }
    return null;
  }

  async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`waitUntil("${label}") timed out`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  function runnerFor(sessionId: string): SessionRunnerInterface {
    return (app as any).runnerRegistry.get(sessionId) as SessionRunnerInterface;
  }

  it("planning#256: live steering on + a real streaming user turn — a systemTurn dispatch is QUEUED, not steered, and its onTurnComplete survives to fire", async () => {
    credentialStore.setLiveSteering(true);

    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Refactor the parser" });
    const userTurn = await waitForClaude(() => lastClaude);
    userTurn.initSession("user-turn-session");
    expect(userTurn.lastUseStreaming).toBe(true);

    const runner = runnerFor(client.sessionId);
    await waitUntil(() => runner.running && runner.isStreamingActive, "user turn running + streaming");

    const completions: { errored: boolean }[] = [];
    runner.dispatch(testDispatch({
      text: WAKE_TEXT,
      activity: "Resuming after child PR merged…",
      systemTurn: true,
      onTurnComplete: (outcome) => completions.push(outcome),
    }));

    const queued = await drainUntil(client, (m) => m.type === "message_queued");
    expect(queued).toMatchObject({ type: "message_queued", text: WAKE_TEXT });
    expect(runner.queueLength).toBe(1);
    expect(userTurn.stdinData.join("")).not.toContain("MERGED");
    expect(completions).toEqual([]);

    userTurn.finish("user-turn-session");
    const wakeTurn = await waitForClaude(() => lastClaude, userTurn);
    expect(wakeTurn.lastPrompt).toContain("merged");

    wakeTurn.finish("wake-turn-session");
    await waitUntil(() => completions.length > 0, "onTurnComplete fired");
    expect(completions).toEqual([TURN_COMPLETED]);

    client.close();
  });

  it("planning#257: a wake-turn queued behind a real INTERACTIVE turn runs as a system turn and fires onTurnComplete (no restart)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Write the docs" });
    const userTurn = await waitForClaude(() => lastClaude);
    userTurn.initSession("user-turn-session");

    const runner = runnerFor(client.sessionId);
    await waitUntil(() => runner.running, "user turn running");

    const completions: { errored: boolean }[] = [];
    runner.dispatch(testDispatch({
      text: WAKE_TEXT,
      activity: "Resuming after child PR merged…",
      systemTurn: true,
      onTurnComplete: (outcome) => completions.push(outcome),
    }));
    await drainUntil(client, (m) => m.type === "message_queued");
    expect(runner.queueLength).toBe(1);

    userTurn.finish("user-turn-session");
    const wakeTurn = await waitForClaude(() => lastClaude, userTurn);
    expect(wakeTurn.lastPrompt).toContain("merged");

    expect(runner.systemTurnInProgress).toBe(true);
    expect(wakeTurn.lastUseStreaming).toBe(false);

    wakeTurn.finish("wake-turn-session");
    await waitUntil(() => completions.length > 0, "onTurnComplete fired");
    expect(completions).toEqual([TURN_COMPLETED]);
    await waitUntil(() => !runner.systemTurnInProgress, "system-turn flag cleared");

    client.close();
  });

  it("docs/288 req 6: a typed message is QUEUED while ShipIt is merging, then STARTS when the hold clears", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "First" });
    const first = await waitForClaude(() => lastClaude);
    first.initSession("first-session");
    first.finish("first-session");
    const runner = runnerFor(client.sessionId);
    await waitUntil(() => !runner.running, "first turn finished");

    runner.mergeHold = true;
    const before = lastClaude;
    client.send({ type: "send_message", text: "typed during the merge" });
    await drainUntil(client, (m) => m.type === "message_queued");
    expect(runner.running).toBe(false);
    expect(runner.queueLength).toBe(1);
    expect(lastClaude).toBe(before);

    runner.mergeHold = false;
    expect(releaseQueuedTurn(runner)).toBe(true);
    const resumed = await waitForClaude(() => lastClaude, before ?? undefined);
    expect(resumed.lastPrompt).toContain("typed during the merge");
    expect(runner.queueLength).toBe(0);
    resumed.finish("resumed-session");

    client.close();
  });

  it("docs/288 req 6: a message is queued even when the hold arrives DURING the send", async () => {
    const claims = (app as unknown as { agentMergeClaims: { markMergeInFlight(id: string): void } })
      .agentMergeClaims;
    const client = await TestClient.connect(port);
    await client.receive();

    const registry = (app as unknown as {
      runnerRegistry: { dispose(id: string, o?: { force?: boolean }): void; get(id: string): unknown };
    }).runnerRegistry;
    registry.dispose(client.sessionId, { force: true });
    expect(registry.get(client.sessionId)).toBeUndefined();

    claims.markMergeInFlight(client.sessionId);
    const before = lastClaude;
    client.send({ type: "send_message", text: "typed as the merge began" });
    await drainUntil(client, (m) => m.type === "message_queued");

    const runner = runnerFor(client.sessionId);
    expect(runner.mergeHold).toBe(true);
    expect(runner.running).toBe(false);
    expect(runner.queueLength).toBe(1);
    expect(lastClaude).toBe(before);

    client.close();
  });

  it("docs/288 req 6: a resident streaming agent is not steered into during a merge", async () => {
    credentialStore.setLiveSteering(true);
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "First" });
    const first = await waitForClaude(() => lastClaude);
    first.initSession("first-session");
    first.finish("first-session");
    const runner = runnerFor(client.sessionId);
    await waitUntil(() => !runner.running, "first turn finished");
    // Restore residency explicitly because finish() clears the fake agent.
    runner.isStreamingActive = true;
    runner.setAgent(first as never);
    expect(runner.getAgent()).not.toBeNull();
    expect(credentialStore.getLiveSteering()).toBe(true);

    runner.mergeHold = true;
    client.send({ type: "send_message", text: "steer me mid-merge" });
    await drainUntil(client, (m) => m.type === "message_queued");

    expect(first.stdinData).toEqual([]);
    expect(runner.queueLength).toBe(1);
    expect(runner.running).toBe(false);

    client.close();
  });

  it("docs/288 req 6: an AskUserQuestion answer is QUEUED while ShipIt is merging", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "First" });
    const first = await waitForClaude(() => lastClaude);
    first.initSession("first-session");
    first.finish("first-session");
    const runner = runnerFor(client.sessionId);
    await waitUntil(() => !runner.running, "first turn finished");

    runner.mergeHold = true;
    const before = lastClaude;
    client.send({
      type: "answer_question", toolUseId: "tu1", answers: { q: "yes" }, text: "yes",
      permissionMode: "plan",
    });
    await drainUntil(client, (m) => m.type === "message_queued");
    expect(runner.running).toBe(false);
    expect(runner.queueLength).toBe(1);
    expect(lastClaude).toBe(before);

    const queued = runner.dequeue();
    expect(queued?.text).toContain("yes");
    expect(queued?.permissionMode).toBe("plan");

    client.close();
  });

  // The gate that keeps a system turn OUT of the queue's head must be re-read when the
  // queue drains: the drain runs the entry directly, and the dispatched executor retires
  // the resident CLI, taking its background work with it (planning#562).
  for (const start of ["interactive", "dispatched"] as const) {
    it(`planning#562: a queued system turn does not drain onto a resident agent with background work (after a ${start} turn)`, async () => {
      credentialStore.setLiveSteering(true);

      const client = await TestClient.connect(port);
      await client.receive();

      const runner = runnerFor(client.sessionId);
      if (start === "interactive") {
        client.send({ type: "send_message", text: "Review the branch" });
      } else {
        runner.dispatch(testDispatch({ text: "Review the branch" }));
      }
      const userTurn = await waitForClaude(() => lastClaude);
      userTurn.initSession("user-turn-session");
      await waitUntil(
        () => runner.running && runner.isStreamingActive && runner.getAgent() !== null,
        "resident streaming turn",
      );

      // The turn backgrounded a cross-agent review; retiring the CLI would destroy it.
      runner.setBackgroundTasks([{ id: "bg-1", description: "Codex consult" }]);
      expect(runner.backgroundWorkDescriptions).toEqual(["Codex consult"]);

      const completions: { errored: boolean }[] = [];
      runner.dispatch(testDispatch({
        text: WAKE_TEXT,
        activity: "Resuming after child PR merged…",
        systemTurn: true,
        onTurnComplete: (outcome) => completions.push(outcome),
      }));
      await drainUntil(client, (m) => m.type === "message_queued");
      expect(runner.queueLength).toBe(1);

      // Settle the turn without exiting the process: the CLI stays resident, as it does
      // in production while its backgrounded work runs.
      userTurn.emit("event", { type: "result", subtype: "success", session_id: "user-turn-session" });
      await waitUntil(() => !runner.running, "user turn settled");
      await new Promise((r) => setTimeout(r, 100));

      expect(runner.queueLength).toBe(1);
      expect(userTurn.killed).toBe(false);
      expect(runner.getAgent()).toBe(userTurn as never);
      expect(lastClaude).toBe(userTurn);
      expect(completions).toEqual([]);

      // The background work finishing is what releases it.
      runner.clearBackgroundTasks();
      const wakeTurn = await waitForClaude(() => lastClaude, userTurn);
      expect(wakeTurn.lastPrompt).toContain("merged");
      expect(runner.queueLength).toBe(0);

      wakeTurn.finish("wake-turn-session");
      await waitUntil(() => completions.length > 0, "onTurnComplete fired");
      expect(completions).toEqual([TURN_COMPLETED]);

      client.close();
    });
  }

  // Deferring is only safe if something releases the entry. When the predecessor is itself a
  // system turn, its CLI exits (clearing the background work) BEFORE its hold is released, so
  // the background-work release fires against a held session and must not consume the entry.
  it("planning#562: a system turn deferred behind a SYSTEM turn runs when the hold clears, and is queued only once", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const runner = runnerFor(client.sessionId);

    runner.dispatch(testDispatch({ text: "CI is red — fix it", systemTurn: true }));
    const systemA = await waitForClaude(() => lastClaude);
    systemA.initSession("system-a-session");
    await waitUntil(() => runner.running && runner.systemTurnInProgress, "system turn A running");

    // A backgrounded a consult of its own.
    runner.isStreamingActive = true;
    runner.setBackgroundTasks([{ id: "bg-1", description: "Codex consult" }]);

    const queuedTwice: string[] = [];
    const completions: { errored: boolean }[] = [];
    runner.dispatch(testDispatch({
      text: WAKE_TEXT,
      activity: "Resuming after child PR merged…",
      systemTurn: true,
      onTurnComplete: (outcome) => completions.push(outcome),
    }));
    void (async () => {
      for (;;) {
        const msg: AnyMsg = await client.receive(4000).catch(() => null);
        if (!msg) return;
        if (msg.type === "message_queued" && msg.text === WAKE_TEXT) queuedTwice.push(msg.text as string);
      }
    })();
    await waitUntil(() => runner.queueLength === 1, "wake turn queued");

    // A settles but its process has not exited yet — the drain defers the wake turn.
    systemA.emit("event", { type: "result", subtype: "success", session_id: "system-a-session" });
    await waitUntil(() => !runner.running, "system turn A settled");
    await new Promise((r) => setTimeout(r, 200));
    expect(runner.queueLength).toBe(1);
    expect(runner.getAgent()).toBe(systemA as never);

    // The CLI exits: background work is cleared while A still holds the session.
    systemA.emit("done", 0);

    const wakeTurn = await waitForClaude(() => lastClaude, systemA);
    expect(wakeTurn.lastPrompt).toContain("merged");
    wakeTurn.finish("wake-turn-session");
    await waitUntil(() => completions.length > 0, "wake turn settled");
    expect(completions).toEqual([TURN_COMPLETED]);
    expect(queuedTwice).toHaveLength(1);

    client.close();
  });

  it("an ordinary user message queued behind a running turn still drains on the interactive path (no server echo bubble)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "First" });
    const first = await waitForClaude(() => lastClaude);
    first.initSession("first-session");

    client.send({ type: "send_message", text: "Second" });
    await drainUntil(client, (m) => m.type === "message_queued");

    const echoes: AnyMsg[] = [];
    const collect = (async (): Promise<void> => {
      for (let i = 0; i < 20; i++) {
        const msg: AnyMsg = await client.receive(1500).catch(() => null);
        if (!msg) return;
        if (msg.type === "system_user_message") echoes.push(msg);
      }
    })();

    first.finish("first-session");
    const second = await waitForClaude(() => lastClaude, first);
    expect(second.lastPrompt).toContain("Second");
    const runner = runnerFor(client.sessionId);
    expect(runner.systemTurnInProgress).toBe(false);

    second.finish("second-session");
    await Promise.race([collect, new Promise((r) => setTimeout(r, 300))]);
    expect(echoes.filter((m) => (m.text as string)?.includes("Second"))).toEqual([]);

    client.close();
  });
});
