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
import type { SessionRunnerInterface, SessionRunnerRegistry } from "../session-runner.js";
import type { TurnOutcome } from "../turn-settlement.js";
import { TURN_COMPLETED } from "../turn-settlement.js";
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
import { testDispatch } from "./dispatch-test-helpers.js";

const WAKE_TEXT = "Child PR #42 merged: child (child-id).";

describe("Integration: a question holds automatic turns (docs/321)", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let lastClaude: FakeClaudeProcess = null as never;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    lastClaude = null as never;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-question-hold-"));
    sessionManager = new SessionManager(dbManager);

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
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

  function registry(): SessionRunnerRegistry {
    return (app as unknown as { runnerRegistry: SessionRunnerRegistry }).runnerRegistry;
  }

  function runnerFor(sessionId: string): SessionRunnerInterface {
    const runner = registry().get(sessionId);
    if (!runner) throw new Error(`no runner for ${sessionId}`);
    return runner;
  }

  /** Keeps the socket drained so a full buffer never stalls the server. */
  function pump(client: TestClient): () => void {
    const state = { stopped: false };
    void (async () => {
      while (!state.stopped) {
        try { await client.receive(500); } catch { /* idle */ }
      }
    })();
    return () => { state.stopped = true; };
  }

  function askQuestion(agent: FakeClaudeProcess): void {
    agent.emit("event", {
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: "ask-1",
          name: "AskUserQuestion",
          input: {
            questions: [{
              question: "Pick a backend",
              header: "Backend",
              options: [{ label: "Redis", description: "In memory" }],
              multiSelect: false,
            }],
          },
        }],
      },
    });
  }

  /** A user turn that ends on a question card. Returns the asking agent. */
  async function turnThatAsks(client: TestClient, before?: FakeClaudeProcess): Promise<FakeClaudeProcess> {
    client.send({ type: "send_message", text: "Which backend should I use?" });
    const asker = await waitForClaude(() => lastClaude, before);
    asker.initSession("question-turn");
    asker.streamingInterrupt = true;
    askQuestion(asker);
    await waitFor(() => asker.interrupted, "the question interrupted the turn");
    return asker;
  }

  function dispatchWake(runner: SessionRunnerInterface, outcomes: TurnOutcome[]) {
    return runner.dispatch(testDispatch({
      text: WAKE_TEXT,
      activity: "Resuming after child PR merged…",
      systemTurn: true,
      automatic: true,
      onTurnComplete: (outcome) => outcomes.push(outcome),
    }));
  }

  it("holds an automatic turn until the user answers, then runs it after the answer (req 1, 3, 4)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const stop = pump(client);

    const asker = await turnThatAsks(client);
    asker.finish("question-turn");
    const runner = runnerFor(client.sessionId);
    await waitFor(() => !runner.running, "question turn settled");
    expect(sessionManager.isAwaitingAnswer(client.sessionId)).toBe(true);

    const outcomes: TurnOutcome[] = [];
    const handle = dispatchWake(runner, outcomes);
    expect(handle.admitted).toBe("queued");
    await new Promise((r) => setTimeout(r, 150));
    expect(lastClaude).toBe(asker);
    expect(runner.queueLength).toBe(0);
    expect(sessionManager.heldTurns(client.sessionId)).toHaveLength(1);

    client.send({ type: "answer_question", toolUseId: "ask-1", answers: { "0": "Redis" } });
    const answerTurn = await waitForClaude(() => lastClaude, asker);
    expect(answerTurn.lastPrompt).toBe("Redis");
    expect(sessionManager.isAwaitingAnswer(client.sessionId)).toBe(false);

    answerTurn.finish("answer-turn");
    const wakeTurn = await waitForClaude(() => lastClaude, answerTurn);
    expect(wakeTurn.lastPrompt).toContain("merged");
    wakeTurn.finish("wake-turn");
    await waitFor(() => outcomes.length > 0, "wake turn settled");
    expect(outcomes).toEqual([TURN_COMPLETED]);

    stop();
    client.close();
  });

  it("keeps an automatic turn queued behind the asking turn, and a typed reply releases it (req 3, 4)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const stop = pump(client);

    const asker = await turnThatAsks(client);
    const runner = runnerFor(client.sessionId);
    const outcomes: TurnOutcome[] = [];
    // Arrives while the asking turn is still running: queued, not steered into it.
    expect(dispatchWake(runner, outcomes).admitted).toBe("queued");

    asker.finish("question-turn");
    await waitFor(() => !runner.running, "question turn settled");
    await new Promise((r) => setTimeout(r, 150));
    expect(lastClaude).toBe(asker);
    expect(runner.queueLength).toBe(0);
    expect(sessionManager.heldTurns(client.sessionId)).toHaveLength(1);
    expect(outcomes).toEqual([]);

    client.send({ type: "send_message", text: "Use Redis" });
    const reply = await waitForClaude(() => lastClaude, asker);
    expect(reply.lastPrompt).toContain("Use Redis");

    reply.finish("reply-turn");
    const wakeTurn = await waitForClaude(() => lastClaude, reply);
    expect(wakeTurn.lastPrompt).toContain("merged");
    wakeTurn.finish("wake-turn");
    await waitFor(() => outcomes.length > 0, "wake turn settled");
    expect(outcomes).toEqual([TURN_COMPLETED]);

    stop();
    client.close();
  });

  it("a message the user queued behind the asking turn runs as the reply, ahead of held automatic work (req 3, 6)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const stop = pump(client);

    const asker = await turnThatAsks(client);
    const runner = runnerFor(client.sessionId);
    const outcomes: TurnOutcome[] = [];
    expect(dispatchWake(runner, outcomes).admitted).toBe("queued");
    client.send({ type: "send_message", text: "Use Redis" });
    await waitFor(() => runner.queueLength === 2, "the reply queued behind the wake");

    asker.finish("question-turn");
    const reply = await waitForClaude(() => lastClaude, asker);
    expect(reply.lastPrompt).toContain("Use Redis");
    expect(runner.queueLength).toBe(1);
    expect(sessionManager.isAwaitingAnswer(client.sessionId)).toBe(false);

    reply.finish("reply-turn");
    const wakeTurn = await waitForClaude(() => lastClaude, reply);
    expect(wakeTurn.lastPrompt).toContain("merged");
    wakeTurn.finish("wake-turn");
    await waitFor(() => outcomes.length > 0, "wake turn settled");
    expect(outcomes).toEqual([TURN_COMPLETED]);

    stop();
    client.close();
  });

  it("a stop still discards what was queued behind the turn", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const stop = pump(client);

    client.send({ type: "send_message", text: "Refactor the parser" });
    const worker = await waitForClaude(() => lastClaude);
    worker.initSession("work-turn");
    const runner = runnerFor(client.sessionId);
    const outcomes: TurnOutcome[] = [];
    expect(dispatchWake(runner, outcomes).admitted).toBe("queued");

    runner.wasInterrupted = true;
    worker.finish("work-turn");
    await waitFor(() => outcomes.length > 0, "the queued wake settled");
    expect(outcomes[0]?.status).toBe("dropped");
    expect(runner.queueLength).toBe(0);

    stop();
    client.close();
  });

  it("an automatic turn that asks holds the automatic work queued behind it (req 1)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const stop = pump(client);
    const runner = runnerFor(client.sessionId);

    // A dispatched turn is not an interrupted interactive one, so its drain reaches the take.
    runner.dispatch(testDispatch({ text: "[ci-fix] CI failed", systemTurn: true, automatic: true }));
    const fixer = await waitForClaude(() => lastClaude);
    fixer.initSession("fix-turn");
    const outcomes: TurnOutcome[] = [];
    expect(dispatchWake(runner, outcomes).admitted).toBe("queued");

    fixer.streamingInterrupt = true;
    askQuestion(fixer);
    await waitFor(() => fixer.interrupted, "the question interrupted the fix turn");
    fixer.finish("fix-turn");
    await waitFor(() => !runner.running && !runner.systemTurnInProgress, "fix turn settled");
    await new Promise((r) => setTimeout(r, 150));
    expect(lastClaude).toBe(fixer);
    expect(runner.queueLength).toBe(0);
    expect(sessionManager.heldTurns(client.sessionId)).toHaveLength(1);
    expect(sessionManager.isAwaitingAnswer(client.sessionId)).toBe(true);

    client.send({ type: "answer_question", toolUseId: "ask-1", answers: { "0": "Redis" } });
    const answerTurn = await waitForClaude(() => lastClaude, fixer);
    expect(answerTurn.lastPrompt).toBe("Redis");
    answerTurn.finish("answer-turn");
    const wakeTurn = await waitForClaude(() => lastClaude, answerTurn);
    expect(wakeTurn.lastPrompt).toContain("merged");
    wakeTurn.finish("wake-turn");
    await waitFor(() => outcomes.length > 0, "wake turn settled");
    expect(outcomes).toEqual([TURN_COMPLETED]);

    stop();
    client.close();
  });

  it("held turns are saved: a new runner still holds them, and they run after the answer (req 5, 8)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const stop = pump(client);

    const asker = await turnThatAsks(client);
    asker.finish("question-turn");
    const first = runnerFor(client.sessionId);
    await waitFor(() => !first.running, "question turn settled");

    const outcomes: TurnOutcome[] = [];
    expect(dispatchWake(first, outcomes).admitted).toBe("queued");
    expect(first.queueLength).toBe(0);
    expect(sessionManager.heldTurns(client.sessionId).map((m) => m.text)).toEqual([WAKE_TEXT]);

    // A stopped container takes its runner with it; the saved turn stays.
    const sessionDir = first.sessionDir;
    registry().dispose(client.sessionId, { force: true });
    expect(outcomes).toEqual([]);
    const fresh = registry().getOrCreate(client.sessionId, sessionDir, "claude");
    expect(fresh).not.toBe(first);
    expect(dispatchWake(fresh, outcomes).admitted).toBe("queued");
    expect(sessionManager.heldTurns(client.sessionId)).toHaveLength(2);
    await new Promise((r) => setTimeout(r, 150));
    expect(lastClaude).toBe(asker);

    client.send({ type: "answer_question", toolUseId: "ask-1", answers: { "0": "Redis" } });
    const answerTurn = await waitForClaude(() => lastClaude, asker);
    expect(answerTurn.lastPrompt).toBe("Redis");
    answerTurn.finish("answer-turn");

    const firstWake = await waitForClaude(() => lastClaude, answerTurn);
    expect(firstWake.lastPrompt).toContain("merged");
    firstWake.finish("wake-1");
    const secondWake = await waitForClaude(() => lastClaude, firstWake);
    expect(secondWake.lastPrompt).toContain("merged");
    secondWake.finish("wake-2");
    await waitFor(() => outcomes.length === 2, "both wakes settled");
    expect(outcomes).toEqual([TURN_COMPLETED, TURN_COMPLETED]);
    expect(sessionManager.heldTurns(client.sessionId)).toEqual([]);

    stop();
    client.close();
  });

  it("a held turn survives its runner going away during the reply, and runs after the next turn (req 8)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const stop = pump(client);

    const asker = await turnThatAsks(client);
    asker.finish("question-turn");
    const first = runnerFor(client.sessionId);
    await waitFor(() => !first.running, "question turn settled");
    const outcomes: TurnOutcome[] = [];
    dispatchWake(first, outcomes);

    client.send({ type: "answer_question", toolUseId: "ask-1", answers: { "0": "Redis" } });
    const answerTurn = await waitForClaude(() => lastClaude, asker);
    // Back in the queue behind the reply, and still saved.
    expect(first.queueLength).toBe(1);
    expect(sessionManager.heldTurns(client.sessionId)).toHaveLength(1);

    registry().dispose(client.sessionId, { force: true });
    expect(outcomes).toEqual([]);
    expect(sessionManager.heldTurns(client.sessionId)).toHaveLength(1);

    client.send({ type: "send_message", text: "Carry on" });
    const next = await waitForClaude(() => lastClaude, answerTurn);
    next.initSession("next-turn");
    next.finish("next-turn");
    const wakeTurn = await waitForClaude(() => lastClaude, next);
    expect(wakeTurn.lastPrompt).toContain("merged");
    wakeTurn.finish("wake-turn");
    await waitFor(() => outcomes.length > 0, "wake turn settled");
    expect(outcomes).toEqual([TURN_COMPLETED]);
    expect(sessionManager.heldTurns(client.sessionId)).toEqual([]);

    stop();
    client.close();
  });

  it("an automatic turn neither releases the hold at its start nor at its end", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const stop = pump(client);

    const asker = await turnThatAsks(client);
    asker.finish("question-turn");
    const runner = runnerFor(client.sessionId);
    await waitFor(() => !runner.running, "question turn settled");

    // Past admission on purpose: this is what a turn does once it runs.
    runner.running = true;
    void runner.runDispatchedTurn(testDispatch({ text: "[ci-fix] CI failed", systemTurn: true, automatic: true }));
    const automaticTurn = await waitForClaude(() => lastClaude, asker);
    expect(sessionManager.isAwaitingAnswer(client.sessionId)).toBe(true);

    automaticTurn.finish("automatic-turn");
    await waitFor(() => !runner.running, "automatic turn settled");
    expect(sessionManager.isAwaitingAnswer(client.sessionId)).toBe(true);

    stop();
    client.close();
  });
});
