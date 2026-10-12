import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
import type * as SessionAgentEnv from "../session-agent-env.js";

// A turn's setup awaits this; the test holds it open to stand inside the setup.
const setup = vi.hoisted(() => ({ gate: null as Promise<void> | null, entered: 0 }));

vi.mock("../session-agent-env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof SessionAgentEnv>();
  return {
    ...actual,
    prepareSessionAgentEnvironment: async (
      ...args: Parameters<typeof SessionAgentEnv.prepareSessionAgentEnvironment>
    ) => {
      setup.entered += 1;
      if (setup.gate) await setup.gate;
      return actual.prepareSessionAgentEnvironment(...args);
    },
  };
});

// docs/329-user-steers-every-turn req 2 — a message waits only for an agent that can read it.
describe("Integration: a message waits only for an agent that can read it", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let credentialStore: CredentialStore;
  let spawns: FakeClaudeProcess[];
  let dbManager: DatabaseManager;
  let headHashFails: boolean;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    spawns = [];
    setup.gate = null;
    setup.entered = 0;
    headHashFails = false;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-message-waits-"));
    credentialStore = createTestCredentialStore(tmpDir);
    credentialStore.setLiveSteering(true);

    app = await buildApp({
      credentialStore,
      // The first thing a typed turn reads, before any agent exists for it.
      createGitManager: (dir: string) => {
        const git = new GitManager(dir);
        const getHeadHash = git.getHeadHash.bind(git);
        git.getHeadHash = async () => {
          if (headHashFails) throw new Error("the repository cannot be read");
          return getHeadHash();
        };
        return git;
      },
      sessionManager: new SessionManager(dbManager),
      chatHistoryManager: new ChatHistoryManager(dbManager),
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => {
        const agent = new FakeClaudeProcess();
        spawns.push(agent);
        return agent as never;
      },
      workspaceDir: tmpDir,
      serveStatic: false,
    });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    port = Number(/:(\d+)$/.exec(address)?.[1] ?? 0);
  });

  afterEach(async () => {
    setup.gate = null;
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* ignore cleanup errors */ }
  });

  async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`waitUntil("${label}") timed out`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  const last = (): FakeClaudeProcess => spawns.at(-1) ?? (null as never);
  const runnerOf = (sessionId: string): SessionRunnerInterface =>
    (app as unknown as { runnerRegistry: { get(id: string): SessionRunnerInterface } }).runnerRegistry.get(sessionId);
  const wrote = (agent: FakeClaudeProcess, text: string): boolean => agent.stdinData.some((d) => d.includes(text));

  function holdSetup(): () => void {
    let open = (): void => {};
    setup.gate = new Promise<void>((resolve) => { open = resolve; });
    return () => {
      setup.gate = null;
      open();
    };
  }

  /** A first turn that ends, so the session has a runner and a resident process. */
  async function finishedFirstTurn(client: TestClient): Promise<{ runner: SessionRunnerInterface; resident: FakeClaudeProcess }> {
    client.send({ type: "send_message", text: "warm up" });
    const resident = await waitForClaude(last);
    resident.initSession("agent-a");
    const runner = runnerOf(client.sessionId);
    resident.emit("event", { type: "result", subtype: "success", session_id: "agent-a" });
    await waitUntil(() => !runner.running && !runner.postTurnWorkInFlight, "the first turn ended");
    return { runner, resident };
  }

  it("gives a message sent while a turn sets up to that turn, after the turn's own prompt", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const { runner, resident } = await finishedFirstTurn(client);

    const openSetup = holdSetup();
    const entered = setup.entered;
    client.send({ type: "send_message", text: "the next task" });
    await waitUntil(() => setup.entered === entered + 1, "the next turn is in its setup");

    client.send({ type: "send_message", text: "and one more thing" });
    await client.receiveType("message_queued");
    // The resident process is alive and idle: written now, the message would start a turn of
    // the CLI's own ahead of the prompt that the turn in setup still has to send.
    expect(wrote(resident, "and one more thing")).toBe(false);

    openSetup();
    await waitUntil(() => wrote(resident, "and one more thing"), "the waiting message reached the agent");

    const written = resident.stdinData.join("\n");
    expect(written.indexOf("the next task")).toBeGreaterThanOrEqual(0);
    expect(written.indexOf("the next task")).toBeLessThan(written.indexOf("and one more thing"));
    expect(runner.queueLength).toBe(0);
    expect(spawns).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 100));
    expect(resident.stdinData.filter((d) => d.includes("and one more thing"))).toHaveLength(1);

    client.close();
  });

  it("gives a message sent while a turn that ShipIt started sets up, with no process yet, to that turn", async () => {
    // A one-shot first turn leaves no process behind.
    credentialStore.setLiveSteering(false);
    const client = await TestClient.connect(port);
    await client.receive();
    client.send({ type: "send_message", text: "warm up" });
    const first = await waitForClaude(last);
    first.initSession("agent-a");
    const runner = runnerOf(client.sessionId);
    first.finish("agent-a");
    await waitUntil(() => !runner.running && !runner.postTurnWorkInFlight, "the first turn ended");
    expect(runner.getAgent()).toBeNull();
    credentialStore.setLiveSteering(true);

    const openSetup = holdSetup();
    const entered = setup.entered;
    runner.dispatch(testDispatch({ text: "Child PR #42 merged", automatic: true }), { whenBusy: "queue" });
    await waitUntil(() => setup.entered === entered + 1, "the wake is in its setup");
    const wake = last();
    expect(wake).not.toBe(first);
    expect(wake.runCalled).toBe(false);

    client.send({ type: "send_message", text: "stop, do this first" });
    await client.receiveType("message_queued");
    expect(wrote(wake, "stop, do this first")).toBe(false);

    openSetup();
    await waitUntil(() => wake.runCalled, "the wake started");
    expect(wake.lastPrompt).toContain("Child PR #42 merged");
    await waitUntil(() => wrote(wake, "stop, do this first"), "the waiting message reached the wake's agent");
    expect(runner.queueLength).toBe(0);
    const steered = await client.receiveType("message_steered");
    expect(steered).toMatchObject({ text: "stop, do this first" });

    client.close();
  });

  it("keeps the order of two typed messages when the first still waits", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const { runner, resident } = await finishedFirstTurn(client);

    client.send({ type: "send_message", text: "a long task" });
    await waitUntil(() => runner.running && wrote(resident, "a long task"), "the task runs");
    fs.writeFileSync(path.join(runner.sessionDir, "note.txt"), "a note\n");
    runner.enqueue({ text: "the earlier request", execution: "interactive", files: [{ path: "note.txt" }] });

    client.send({ type: "send_message", text: "a newer correction" });
    await waitUntil(() => wrote(resident, "a newer correction"), "both messages reached the agent");

    const written = resident.stdinData.join("\n");
    expect(written.indexOf("the earlier request")).toBeGreaterThanOrEqual(0);
    expect(written.indexOf("the earlier request")).toBeLessThan(written.indexOf("a newer correction"));
    expect(runner.queueLength).toBe(0);

    client.close();
  });

  it("keeps a message out of a compaction turn, and runs it when the compaction ends", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const { runner, resident } = await finishedFirstTurn(client);

    client.send({ type: "send_message", text: "/compact" });
    await waitUntil(() => wrote(resident, "/compact"), "the compaction turn runs");
    await waitUntil(() => runner.running, "the compaction turn has the runner");

    client.send({ type: "send_message", text: "after the compaction" });
    await client.receiveType("message_queued");
    expect(wrote(resident, "after the compaction")).toBe(false);

    resident.emit("event", { type: "result", subtype: "success", session_id: "agent-a" });
    await waitUntil(() => wrote(resident, "after the compaction"), "the message ran after the compaction");
    expect(runner.queueLength).toBe(0);

    client.close();
  });

  it("queues a /compact typed while ShipIt holds the session, and does not compact the idle agent", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const { runner, resident } = await finishedFirstTurn(client);

    runner.systemTurnInProgress = true;
    client.send({ type: "send_message", text: "/compact" });
    await client.receiveType("message_queued");

    expect(resident.compactCalled).toBe(false);
    expect(runner.messageQueue.map((m) => m.text)).toEqual(["/compact"]);

    runner.systemTurnInProgress = false;
    client.close();
  });

  // `verifyRunningState` leaves a claim in setup alone, so a setup that fails must end its own.
  it("gives the session back when a typed turn fails before it has an agent", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const { runner, resident } = await finishedFirstTurn(client);

    headHashFails = true;
    client.send({ type: "send_message", text: "this turn cannot start" });
    await client.receiveType("error");
    expect(runner.running).toBe(false);

    headHashFails = false;
    client.send({ type: "send_message", text: "the next one can" });
    await waitUntil(() => wrote(resident, "the next one can"), "the next message runs");

    client.close();
  });

  it("steers an answer into a turn that did not ask", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const { runner, resident } = await finishedFirstTurn(client);

    client.send({ type: "send_message", text: "a long task" });
    await waitUntil(() => runner.running && wrote(resident, "a long task"), "the task runs");

    client.send({ type: "answer_question", toolUseId: "old-card", answers: { "0": "Redis" } });
    await waitUntil(() => wrote(resident, "Redis"), "the answer reached the agent");

    expect(resident.killed).toBe(false);
    expect(spawns).toHaveLength(1);
    expect(runner.queueLength).toBe(0);

    client.close();
  });

  it("queues an answer behind a turn that did not ask and cannot take it, and does not end that turn", async () => {
    credentialStore.setLiveSteering(false);
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "a long task" });
    const task = await waitForClaude(last);
    task.initSession("agent-a");
    const runner = runnerOf(client.sessionId);

    client.send({ type: "answer_question", toolUseId: "old-card", answers: { "0": "Redis" } });
    await client.receiveType("message_queued");

    expect(task.killed).toBe(false);
    expect(runner.running).toBe(true);
    expect(runner.messageQueue.map((m) => m.text)).toEqual(["Redis"]);

    task.finish("agent-a");
    const answerTurn = await waitForClaude(last, task);
    expect(answerTurn.lastPrompt).toBe("Redis");

    client.close();
  });

  it("queues an answer while ShipIt holds the session, where it refused it before", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const { runner, resident } = await finishedFirstTurn(client);

    runner.systemTurnInProgress = true;
    client.send({ type: "answer_question", toolUseId: "card", answers: { "0": "Redis" } });
    await client.receiveType("message_queued");

    expect(runner.messageQueue.map((m) => m.text)).toEqual(["Redis"]);
    expect(resident.killed).toBe(false);
    expect(wrote(resident, "Redis")).toBe(false);

    runner.systemTurnInProgress = false;
    client.close();
  });
});
