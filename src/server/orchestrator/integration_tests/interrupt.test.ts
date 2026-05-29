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

    // Session workspaces inherit `user.name` / `user.email` from this global
    // config — without it, the post-interrupt commit fallback's `git commit`
    // fails the "Please tell me who you are" check.
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
    await client.receive(); // preview_status

    // Start a Claude process
    client.send({ type: "send_message", text: "do something" });
    await waitForClaude(() => lastClaude);

    // Send interrupt
    client.send({ type: "interrupt_agent" });

    const interrupted = await client.receiveType("agent_interrupted");
    expect(interrupted).toMatchObject({ type: "agent_interrupted" });

    // The FakeClaudeProcess should have been interrupted
    expect(lastClaude.interrupted).toBe(true);

    client.close();
  });

  it("returns error when interrupting with no active process", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Send interrupt with no active process
    client.send({ type: "interrupt_agent" });

    const response = await client.receiveType("error");
    expect((response as any).message).toBe("No active agent process to interrupt");

    client.close();
  });

  it("does not send spurious error after interrupt", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Start a Claude process
    client.send({ type: "send_message", text: "test" });
    await waitForClaude(() => lastClaude);

    // Send interrupt — this triggers agent_interrupted immediately,
    // and FakeClaudeProcess.interrupt() emits "done" with code 1 after 10ms.
    client.send({ type: "interrupt_agent" });

    const interrupted = await client.receiveType("agent_interrupted");
    expect(interrupted).toMatchObject({ type: "agent_interrupted" });

    // Wait for the process to finish (FakeClaudeProcess emits done after 10ms)
    await new Promise((r) => setTimeout(r, 200));

    // Collect any remaining non-log messages
    const remaining: WsServerMessage[] = [];
    try {
      while (true) {
        const msg = await client.receiveSkipLogs(500);
        remaining.push(msg);
      }
    } catch {
      // Expected timeout — no more messages
    }

    // There should be no "error" message about process exit
    const errors = remaining.filter((m) => m.type === "error");
    expect(errors).toHaveLength(0);

    client.close();
  });

  it("clears message queue on interrupt", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Start a Claude process
    client.send({ type: "send_message", text: "first message" });
    await waitForClaude(() => lastClaude);

    // Queue a second message while Claude is busy
    client.send({ type: "send_message", text: "queued message" });
    const queued = await client.receiveType("message_queued");
    expect(queued).toMatchObject({ type: "message_queued", text: "queued message" });

    // Interrupt — should clear the queue
    client.send({ type: "interrupt_agent" });

    await client.receiveType("agent_interrupted");

    // Wait for done handler to fire and clear queue
    await new Promise((r) => setTimeout(r, 200));

    // Should receive queue_updated with empty queue
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
    await client.receive(); // preview_status

    // Resolve the session's workspace dir so we can plant a file the
    // post-interrupt commit fallback should pick up.
    const session = sessionManager.get(client.sessionId);
    expect(session?.workspaceDir).toBeTruthy();
    const sessionDir = session!.workspaceDir!;

    client.send({ type: "send_message", text: "edit a file" });
    await waitForClaude(() => lastClaude);

    // Establish the session so the post-turn flow has the agent's session_id.
    lastClaude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "test-session",
    });
    await client.receiveType("session_started");

    // Simulate the agent writing a file partway through the turn — this is
    // exactly the partial work that used to be lost on interrupt in streaming
    // mode.
    fs.writeFileSync(path.join(sessionDir, "partial-work.txt"), "in progress");

    // Interrupt before the agent emits agent_result.
    client.send({ type: "interrupt_agent" });
    await client.receiveType("agent_interrupted");

    // The fallback fires after INTERRUPT_COMMIT_FALLBACK_DELAY_MS (2s); allow
    // a generous wait for the deferred commit to land.
    const committed = await client.receiveType("git_committed", 5000);
    expect((committed as { hash?: string }).hash).toBeTruthy();
    expect((committed as { message?: string }).message).toBeTruthy();

    client.close();
  });

  it("preserves the interrupted turn's assistant work in chat history", async () => {
    // Regression: when the user interrupted mid-turn the agent exited without
    // an `agent_result`, leaving in_progress=1 rows. The next turn's first
    // replaceInProgress wiped them — so the work the user just SAW the agent
    // do disappeared from the chat history on reload.
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "design a new enemy" });
    const claude = await waitForClaude(() => lastClaude);

    // Agent emits some progress (assistant text + a tool call) before the
    // user interrupts. agent-listeners persists these as in_progress=1 rows.
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

    // Wait for the in-progress rows to settle.
    await new Promise((r) => setTimeout(r, 100));

    // Interrupt — FakeClaudeProcess emits done(1) without agent_result.
    client.send({ type: "interrupt_agent" });
    await client.receiveType("agent_interrupted");
    await new Promise((r) => setTimeout(r, 200));

    // Send a second message, which kicks off a new turn whose first
    // replaceInProgress would have wiped the interrupted turn under the
    // pre-fix behavior.
    client.send({ type: "send_message", text: "continue" });
    await waitForClaude(() => lastClaude, claude);
    await new Promise((r) => setTimeout(r, 50));

    const history = chatHistoryManager.load(client.sessionId);
    const assistantTexts = history.filter((m) => m.role === "assistant").map((m) => m.text);
    // The interrupted turn's text must still be visible after the new turn began.
    expect(assistantTexts).toContain("I'll add a Bomber enemy.");

    client.close();
  });

  it("allows sending a new message after interrupt (redirect)", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Start a Claude process
    client.send({ type: "send_message", text: "wrong approach" });
    const firstClaude = await waitForClaude(() => lastClaude);

    // Interrupt
    client.send({ type: "interrupt_agent" });
    await client.receiveType("agent_interrupted");

    // Wait for done handler to complete
    await new Promise((r) => setTimeout(r, 200));

    // Drain any remaining messages before sending redirect
    try {
      while (true) {
        await client.receive(200);
      }
    } catch {
      // Expected timeout
    }

    // Now send a redirect message
    client.send({ type: "send_message", text: "try this instead" });

    // A new Claude process should be created
    const secondClaude = await waitForClaude(() => lastClaude, firstClaude);
    expect(secondClaude).not.toBe(firstClaude);
    expect(secondClaude.runCalled).toBe(true);

    // Clean up
    secondClaude.finish("redirect-session");
    client.close();
  });
});
