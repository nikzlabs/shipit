import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import { initGlobalGitConfig, setGitIdentity } from "../git-config.js";


import type { WsServerMessage } from "../../shared/types.js";
import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  waitFor,
  waitForClaude,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { testDispatch } from "./dispatch-test-helpers.js";
import { takeSessionHold } from "../session-hold.js";
import type { TurnOutcome } from "../turn-settlement.js";
import { DatabaseManager } from "../../shared/database.js";

describe("Integration: Interrupt and Redirect", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let chatHistoryManager: ChatHistoryManager;
  let lastClaude: FakeClaudeProcess;
  let dbManager: DatabaseManager;
  /** While set, every git call waits for it: the commit after a turn stays open. */
  let gitGate: Promise<void> | null = null;

  function gatedGit(git: GitManager): GitManager {
    return new Proxy(git, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const gate = gitGate;
          const call = () => (value as (...a: unknown[]) => unknown).apply(target, args);
          if (!gate) return call();
          return (async () => {
            await gate;
            return call();
          })();
        };
      },
    });
  }

  beforeEach(async () => {
    gitGate = null;
    dbManager = createTestDatabaseManager();
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-interrupt-"));

    initGlobalGitConfig(path.join(tmpDir, "credentials"));
    setGitIdentity("Test User", "test@example.com");

    sessionManager = new SessionManager(dbManager);
    chatHistoryManager = new ChatHistoryManager(dbManager);

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => gatedGit(new GitManager(dir)),
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

  it("sends agent_interrupted when interrupting an active agent process", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "do something" });
    await waitForClaude(() => lastClaude);

    client.send({ type: "interrupt_agent" });

    const interrupted = await client.receiveType("agent_interrupted");
    expect(interrupted).toMatchObject({ type: "agent_interrupted" });

    expect(lastClaude.interrupted).toBe(true);

    client.close();
  });

  it("ends the process that runs a background task, so the task cannot wake a stopped agent", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    const sessionId = client.sessionId;
    client.send({ type: "send_message", text: "run the tests in the background" });
    const claude = await waitForClaude(() => lastClaude);
    claude.doneOnKill = true;
    claude.initSession("stop-background");
    await client.receiveType("session_started");
    // Model a resident process; this fixture disables live steering.
    app.runnerRegistry.get(sessionId)!.isStreamingActive = true;
    claude.emit("event", {
      type: "agent_background_tasks",
      tasks: [{ id: "bg-1", type: "local_bash", description: "npm test" }],
    });

    client.send({ type: "interrupt_agent" });
    await client.receiveType("agent_interrupted");
    expect(claude.killed).toBe(true);
    await new Promise((r) => setTimeout(r, 250));

    const res = await fetch(`http://127.0.0.1:${String(port)}/api/sessions/${sessionId}/history`);
    const body = await res.json() as { agentRunning: boolean; backgroundTasks: string[] };
    expect(body.agentRunning).toBe(false);
    expect(body.backgroundTasks).toEqual([]);

    client.close();
  });

  it("returns error when interrupting with no active process", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "interrupt_agent" });

    const response = await client.receiveType("error");
    expect((response as any).message).toBe("No active agent process to interrupt");

    client.close();
  });

  it("does not send spurious error after interrupt", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "test" });
    await waitForClaude(() => lastClaude);

    client.send({ type: "interrupt_agent" });

    const interrupted = await client.receiveType("agent_interrupted");
    expect(interrupted).toMatchObject({ type: "agent_interrupted" });

    await new Promise((r) => setTimeout(r, 200));

    const remaining: WsServerMessage[] = [];
    try {
      while (true) {
        const msg = await client.receiveSkipLogs(500);
        remaining.push(msg);
      }
    } catch {
      // Expected timeout — no more messages
    }

    const errors = remaining.filter((m) => m.type === "error");
    expect(errors).toHaveLength(0);

    client.close();
  });

  describe("a Stop returns the queued messages (docs/330-stop-returns-queued-messages)", () => {
    type QueueUpdate = Extract<WsServerMessage, { type: "queue_updated" }>;

    /** The next `queue_updated` that names returned messages. */
    async function nextReturn(client: TestClient): Promise<QueueUpdate> {
      for (;;) {
        const msg = await client.receiveType("queue_updated");
        if (msg.type === "queue_updated" && msg.returned) return msg;
      }
    }

    async function queueTyped(client: TestClient, text: string, extra: Record<string, unknown> = {}): Promise<string> {
      client.send({ type: "send_message", text, ...extra });
      for (;;) {
        const queued = await client.receiveType("message_queued");
        if (queued.type === "message_queued" && queued.text === text) return queued.id;
      }
    }

    it("puts the user's waiting message in the returned list and empties the queue (req 1, 2)", async () => {
      const client = await TestClient.connect(port);
      await client.receive();
      client.send({ type: "send_message", text: "first message" });
      const turn = await waitForClaude(() => lastClaude);
      const id = await queueTyped(client, "queued message", {
        files: [{ path: "src/a.ts" }],
        uploads: [{ path: "/uploads/shot.png", type: "upload" }],
      });

      client.send({ type: "interrupt_agent" });

      const update = await nextReturn(client);
      expect(update.queue).toEqual([]);
      expect(update.returned).toEqual([{
        id,
        text: "queued message",
        files: [{ path: "src/a.ts" }, { path: "/uploads/shot.png" }],
      }]);
      await client.receiveType("agent_interrupted");
      expect(app.runnerRegistry.get(client.sessionId)!.queueLength).toBe(0);

      // The stopped turn ends, and nothing starts by itself.
      await waitFor(() => !app.runnerRegistry.get(client.sessionId)!.running, "the stopped turn ended");
      await new Promise((r) => setTimeout(r, 150));
      expect(lastClaude).toBe(turn);

      client.close();
    });

    it("keeps the returned messages for a viewer that attaches later, until one has them", async () => {
      const client = await TestClient.connect(port);
      await client.receive();
      client.send({ type: "send_message", text: "first message" });
      await waitForClaude(() => lastClaude);
      const id = await queueTyped(client, "queued message");
      client.send({ type: "interrupt_agent" });
      await nextReturn(client);

      /** Every list of returned messages that a viewer gets when it attaches. */
      const listsOnAttach = async (): Promise<unknown[]> => {
        const viewer = await TestClient.connect(port, client.sessionId);
        const events = await viewer.drain({ quietMs: 200 });
        viewer.close();
        return events.flatMap((m) => (m.type === "queue_updated" && m.returned ? [m.returned] : []));
      };

      // From the runner, one time: the replay of the Stop's own event does not carry them.
      expect(await listsOnAttach()).toEqual([[{ id, text: "queued message" }]]);

      client.send({ type: "queue_returned_taken", ids: [id] });
      await waitFor(async () => (await listsOnAttach()).length === 0, "no viewer is offered a taken message");

      client.close();
    });

    it("returns a message that was on its way at the Stop, instead of starting its turn", async () => {
      const client = await TestClient.connect(port);
      await client.receive();
      client.send({ type: "send_message", text: "first message" });
      const turn = await waitForClaude(() => lastClaude);
      const runner = app.runnerRegistry.get(client.sessionId)!;
      let openGate!: () => void;
      gitGate = new Promise<void>((resolve) => { openGate = resolve; });
      turn.finish("first");
      await waitFor(() => !runner.running && runner.turnCommitPending, "the commit after the turn is open");

      // The send waits for that commit; the Stop comes meanwhile.
      client.send({ type: "send_message", text: "on its way" });
      await new Promise((r) => setTimeout(r, 50));
      client.send({ type: "interrupt_agent" });
      await new Promise((r) => setTimeout(r, 50));
      gitGate = null;
      openGate();

      expect((await nextReturn(client)).returned).toMatchObject([{ text: "on its way" }]);
      await new Promise((r) => setTimeout(r, 200));
      expect(lastClaude).toBe(turn);
      expect(runner.running).toBe(false);

      client.close();
    });

    it("runs a message that the user sends after the Stop", async () => {
      const client = await TestClient.connect(port);
      await client.receive();
      client.send({ type: "send_message", text: "first message" });
      const turn = await waitForClaude(() => lastClaude);
      turn.streamingInterrupt = true;
      await queueTyped(client, "queued message");

      client.send({ type: "interrupt_agent" });
      await client.receiveType("agent_interrupted");
      await queueTyped(client, "the redirect");
      turn.finish("stopped");

      const next = await waitForClaude(() => lastClaude, turn);
      expect(next.lastPrompt).toContain("the redirect");
      expect(next.lastPrompt).not.toContain("queued message");

      client.close();
    });

    it("removes an entry that ShipIt put in the queue, and tells its sender (req 3)", async () => {
      const client = await TestClient.connect(port);
      await client.receive();
      const runner = app.runnerRegistry.get(client.sessionId)!;
      // A turn that ShipIt started: the same rule as behind a turn that the user typed.
      runner.dispatch(testDispatch({ text: "[ci-fix] CI failed", automatic: true }));
      const turn = await waitForClaude(() => lastClaude);
      const outcomes: TurnOutcome[] = [];
      const wake = runner.dispatch(
        testDispatch({ text: "[merge] PR merged", automatic: true, onTurnComplete: (o) => outcomes.push(o) }),
        { whenBusy: "queue" },
      );
      expect(wake.admitted).toBe("queued");
      const id = await queueTyped(client, "my note");

      client.send({ type: "interrupt_agent" });

      const update = await nextReturn(client);
      expect(update.queue).toEqual([]);
      expect(update.returned).toEqual([{ id, text: "my note" }]);
      expect(outcomes).toEqual([{ status: "dropped", errored: true, detail: "stopped by the user" }]);

      await waitFor(() => !runner.running, "the stopped turn ended");
      await new Promise((r) => setTimeout(r, 150));
      expect(lastClaude).toBe(turn);

      client.close();
    });

    it("empties a queue that a hold keeps while no turn runs", async () => {
      const client = await TestClient.connect(port);
      await client.receive();
      // A first turn makes the runner; the hold then keeps the next message in the queue.
      client.send({ type: "send_message", text: "first message" });
      (await waitForClaude(() => lastClaude)).finish("first");
      const runner = app.runnerRegistry.get(client.sessionId)!;
      await waitFor(() => !runner.running && !runner.turnCommitPending, "the first turn ended");
      const hold = takeSessionHold(runner);
      const id = await queueTyped(client, "sent under the hold");

      client.send({ type: "interrupt_agent" });

      expect((await nextReturn(client)).returned).toEqual([{ id, text: "sent under the hold" }]);
      await client.receiveType("agent_interrupted");
      expect(runner.queueLength).toBe(0);

      hold.release();
      client.close();
    });

    it("the user's Kill returns the queue as their Stop does", async () => {
      const client = await TestClient.connect(port);
      await client.receive();
      client.send({ type: "send_message", text: "first message" });
      await waitForClaude(() => lastClaude);
      const id = await queueTyped(client, "queued message");

      const res = await app.inject({ method: "POST", url: `/api/sessions/${client.sessionId}/agent/kill` });
      expect(res.statusCode).toBe(200);

      expect((await nextReturn(client)).returned).toEqual([{ id, text: "queued message" }]);

      client.close();
    });

    it("a queue row that the user cancels settles its sender", async () => {
      const client = await TestClient.connect(port);
      await client.receive();
      client.send({ type: "send_message", text: "first message" });
      await waitForClaude(() => lastClaude);
      const runner = app.runnerRegistry.get(client.sessionId)!;
      const outcomes: TurnOutcome[] = [];
      runner.dispatch(
        testDispatch({ text: "[ci-fix] CI failed", automatic: true, onTurnComplete: (o) => outcomes.push(o) }),
        { whenBusy: "queue" },
      );

      client.send({ type: "cancel_queued_message", position: 0 });

      await waitFor(() => outcomes.length > 0, "the sender was told");
      expect(outcomes).toEqual([{ status: "dropped", errored: true, detail: "cancelled by the user" }]);

      client.close();
    });
  });

  it("commits partial work after interrupt (deferred fallback)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    const session = sessionManager.get(client.sessionId);
    expect(session?.workspaceDir).toBeTruthy();
    const sessionDir = session!.workspaceDir!;

    client.send({ type: "send_message", text: "edit a file" });
    await waitForClaude(() => lastClaude);

    lastClaude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "test-session",
    });
    await client.receiveType("session_started");

    fs.writeFileSync(path.join(sessionDir, "partial-work.txt"), "in progress");

    client.send({ type: "interrupt_agent" });
    await client.receiveType("agent_interrupted");

    const committed = await client.receiveType("git_committed", 5000);
    expect((committed as { hash?: string }).hash).toBeTruthy();
    expect((committed as { message?: string }).message).toBeTruthy();

    client.close();
  });

  it("commits partial work when a stopped STREAMING process reports neither done nor result", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    const session = sessionManager.get(client.sessionId);
    const sessionDir = session!.workspaceDir!;

    client.send({ type: "send_message", text: "edit a file" });
    const claude = await waitForClaude(() => lastClaude);
    claude.emit("event", { type: "system", subtype: "init", session_id: "streaming-interrupt" });
    await client.receiveType("session_started");

    app.runnerRegistry.get(client.sessionId)!.isStreamingActive = true;
    // Emit neither done nor result, leaving only the deferred commit fallback.
    claude.streamingInterrupt = true;

    fs.writeFileSync(path.join(sessionDir, "partial-work.txt"), "in progress");

    client.send({ type: "interrupt_agent" });
    await client.receiveType("agent_interrupted");

    const committed = await client.receiveType("git_committed", 8000);
    expect((committed as { hash?: string }).hash).toBeTruthy();
    expect(claude.killed).toBe(true);
    expect(
      fs.readFileSync(path.join(sessionDir, "partial-work.txt"), "utf8"),
    ).toBe("in progress");

    client.close();
  }, 20000);

  it("preserves the interrupted turn's assistant work in chat history", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "design a new enemy" });
    const claude = await waitForClaude(() => lastClaude);

    claude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "agent-interrupt-preserve",
    });
    await client.receiveType("session_started");
    claude.emit("event", {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "I'll add a Bomber enemy." },
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/entities/EnemyTank.js" } },
        ],
      },
    });
    claude.emit("event", {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "t1", content: "..." }],
      },
    });

    await new Promise((r) => setTimeout(r, 100));

    client.send({ type: "interrupt_agent" });
    await client.receiveType("agent_interrupted");
    await new Promise((r) => setTimeout(r, 200));

    client.send({ type: "send_message", text: "continue" });
    await waitForClaude(() => lastClaude, claude);
    await new Promise((r) => setTimeout(r, 50));

    const history = chatHistoryManager.load(client.sessionId);
    const assistantTexts = history.filter((m) => m.role === "assistant").map((m) => m.text);
    expect(assistantTexts).toContain("I'll add a Bomber enemy.");

    client.close();
  });

  it("allows sending a new message after interrupt (redirect)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "wrong approach" });
    const firstClaude = await waitForClaude(() => lastClaude);

    client.send({ type: "interrupt_agent" });
    await client.receiveType("agent_interrupted");

    await new Promise((r) => setTimeout(r, 200));

    try {
      while (true) {
        await client.receive(200);
      }
    } catch {
      // Expected timeout
    }

    client.send({ type: "send_message", text: "try this instead" });

    const secondClaude = await waitForClaude(() => lastClaude, firstClaude);
    expect(secondClaude).not.toBe(firstClaude);
    expect(secondClaude.runCalled).toBe(true);

    secondClaude.finish("redirect-session");
    client.close();
  });
});
