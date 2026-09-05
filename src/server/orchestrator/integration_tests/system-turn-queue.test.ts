/**
 * A dispatched SYSTEM turn must survive a busy session (planning#256 + planning#257).
 *
 * Both regressions below are about the same promise, made by docs/196's
 * notify-on-merge and relied on by every other `dispatch({ systemTurn: true,
 * onTurnComplete })` caller (the rebase driver, the CI auto-fix loop): a system
 * turn dispatched while the session is busy is QUEUED, later RUNS AS A SYSTEM
 * TURN, and fires its completion callback when it does.
 *
 * They slipped through because the existing coverage models a busy runner with a
 * fake (`merge-watch.test.ts`), which can't reproduce either failure: both live
 * in the real turn machinery. So these drive a REAL turn through the WS path,
 * with a real runner, a real queue, and the real drain.
 *
 *   • planning#256 — with live steering on, `trySteerDispatch` consulted only whether
 *     the RUNNING turn was a system turn, never whether the INCOMING dispatch
 *     was. A wake-turn arriving during an ordinary streaming user turn was
 *     therefore injected into that turn via `sendUserMessage`, and since the
 *     steer path returns before any enqueue, `onTurnComplete` was dropped
 *     entirely — the merge watch could never reach `delivered`.
 *
 *   • planning#257 — the WS drain re-entered `runAgentWithMessage` with only text,
 *     images, files, and the agent session id, so a queued system turn lost both
 *     `systemTurn` and `onTurnComplete` and ran as an ordinary interactive turn.
 */

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

  /** Drain client messages until `predicate` matches (or we run out). */
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
    await client.receive(); // preview_status

    // A REAL, streaming user turn is in flight — the precondition the fake busy
    // runner could never model: `isStreamingActive` is true and the resident
    // process is steerable, so `shouldSteerMessage` says "steer".
    client.send({ type: "send_message", text: "Refactor the parser" });
    const userTurn = await waitForClaude(() => lastClaude);
    userTurn.initSession("user-turn-session");
    expect(userTurn.lastUseStreaming).toBe(true);

    const runner = runnerFor(client.sessionId);
    await waitUntil(() => runner.running && runner.isStreamingActive, "user turn running + streaming");

    // The wake-turn arrives mid-turn.
    const completions: { errored: boolean }[] = [];
    runner.dispatch(testDispatch({
      text: WAKE_TEXT,
      activity: "Resuming after child PR merged…",
      systemTurn: true,
      onTurnComplete: (outcome) => completions.push(outcome),
    }));

    // It must QUEUE. Before the fix it was steered into the user's turn:
    // `sendUserMessage` (captured by the fake as stdin) carried the wake text
    // into someone else's context, nothing was enqueued, and the callback was
    // dropped on the floor.
    const queued = await drainUntil(client, (m) => m.type === "message_queued");
    expect(queued).toMatchObject({ type: "message_queued", text: WAKE_TEXT });
    expect(runner.queueLength).toBe(1);
    expect(userTurn.stdinData.join("")).not.toContain("MERGED");
    expect(completions).toEqual([]);

    // The user turn ends → the queued wake-turn drains and runs…
    userTurn.finish("user-turn-session");
    const wakeTurn = await waitForClaude(() => lastClaude, userTurn);
    expect(wakeTurn.lastPrompt).toContain("merged");

    // …and only when it completes does the callback fire — exactly once.
    wakeTurn.finish("wake-turn-session");
    await waitUntil(() => completions.length > 0, "onTurnComplete fired");
    expect(completions).toEqual([TURN_COMPLETED]);

    client.close();
  });

  it("planning#257: a wake-turn queued behind a real INTERACTIVE turn runs as a system turn and fires onTurnComplete (no restart)", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // A real interactive (non-streaming) user turn — the common busy-parent case.
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

    // The interactive turn's OWN drain shifts this entry. It used to re-enter
    // `runAgentWithMessage` with text + attachments only, so the wake-turn ran
    // as an ordinary interactive turn: no `systemTurn`, no `onTurnComplete`.
    userTurn.finish("user-turn-session");
    const wakeTurn = await waitForClaude(() => lastClaude, userTurn);
    expect(wakeTurn.lastPrompt).toContain("merged");

    // It runs AS A SYSTEM TURN: the flag is set for its duration (so a message
    // arriving now is queued rather than steered into it), and it does not adopt
    // the streaming/steerable shape of a user turn.
    expect(runner.systemTurnInProgress).toBe(true);
    expect(wakeTurn.lastUseStreaming).toBe(false);

    // And it reaches its terminal state in-process — the callback fires, which
    // is what advances a merge watch to `delivered` without an orchestrator
    // restart. The system-turn flag is cleared on teardown.
    wakeTurn.finish("wake-turn-session");
    await waitUntil(() => completions.length > 0, "onTurnComplete fired");
    expect(completions).toEqual([TURN_COMPLETED]);
    await waitUntil(() => !runner.systemTurnInProgress, "system-turn flag cleared");

    client.close();
  });

  it("docs/288 req 6: a typed message is QUEUED while ShipIt is merging, and starts when the hold clears", async () => {
    // The interactive send has its own admission check, separate from
    // `dispatchOnRunner`'s. Without the hold there, a user typing during a
    // background merge starts a turn that pushes behind a merge in flight.
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // A first turn so the runner exists, then let it finish: the hold has to be
    // what queues the next message, not a turn still running.
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
    expect(lastClaude).toBe(before); // no new agent was spawned

    client.close();
  });

  it("docs/288 req 6: an AskUserQuestion answer is QUEUED while ShipIt is merging", async () => {
    // `answer_question` does not go through `dispatch` at all — it sets
    // `running = true` and calls `runAgentWithMessage` itself, which is exactly
    // why it was the turn-start path most easily missed.
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "First" });
    const first = await waitForClaude(() => lastClaude);
    first.initSession("first-session");
    first.finish("first-session");
    const runner = runnerFor(client.sessionId);
    await waitUntil(() => !runner.running, "first turn finished");

    runner.mergeHold = true;
    const before = lastClaude;
    client.send({ type: "answer_question", toolUseId: "tu1", answers: { q: "yes" }, text: "yes" });
    await drainUntil(client, (m) => m.type === "message_queued");
    expect(runner.running).toBe(false);
    expect(runner.queueLength).toBe(1);
    expect(lastClaude).toBe(before);

    client.close();
  });

  it("an ordinary user message queued behind a running turn still drains on the interactive path (no server echo bubble)", async () => {
    // The routing tag must not change what a user-typed queued message does: it
    // stays interactive, so the drain does NOT emit a `system_user_message` echo
    // on top of the client's optimistic bubble.
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

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
