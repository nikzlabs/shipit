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
  waitForClaude,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";

describe("Integration: Interrupt and Redirect", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let chatHistoryManager: ChatHistoryManager;
  let lastClaude: FakeClaudeProcess;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-interrupt-"));

    initGlobalGitConfig(path.join(tmpDir, "credentials"));
    setGitIdentity("Test User", "test@example.com");

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

  it("clears message queue on interrupt", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "first message" });
    await waitForClaude(() => lastClaude);

    client.send({ type: "send_message", text: "queued message" });
    const queued = await client.receiveType("message_queued");
    expect(queued).toMatchObject({ type: "message_queued", text: "queued message" });

    client.send({ type: "interrupt_agent" });

    await client.receiveType("agent_interrupted");

    await new Promise((r) => setTimeout(r, 200));

    const remaining: WsServerMessage[] = [];
    try {
      while (true) {
        const msg = await client.receiveSkipLogs(500);
        remaining.push(msg);
      }
    } catch {
      // Expected timeout
    }

    const queueUpdates = remaining.filter((m) => m.type === "queue_updated");
    expect(queueUpdates.length).toBeGreaterThanOrEqual(1);
    const lastUpdate = queueUpdates[queueUpdates.length - 1];
    expect(lastUpdate).toMatchObject({ type: "queue_updated", queue: [] });

    client.close();
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

  it("commits partial work when a STREAMING interrupt leaves the process resident", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    const session = sessionManager.get(client.sessionId);
    const sessionDir = session!.workspaceDir!;

    client.send({ type: "send_message", text: "edit a file" });
    const claude = await waitForClaude(() => lastClaude);
    claude.emit("event", { type: "system", subtype: "init", session_id: "streaming-interrupt" });
    await client.receiveType("session_started");

    // Emit neither done nor result, leaving only the deferred commit fallback.
    claude.streamingInterrupt = true;

    fs.writeFileSync(path.join(sessionDir, "partial-work.txt"), "in progress");

    client.send({ type: "interrupt_agent" });
    await client.receiveType("agent_interrupted");

    const committed = await client.receiveType("git_committed", 8000);
    expect((committed as { hash?: string }).hash).toBeTruthy();
    expect(claude.killed).toBe(false);
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
