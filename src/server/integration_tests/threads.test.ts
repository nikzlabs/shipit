import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../auth.js";
import { GitHubAuthManager } from "../github-auth.js";
import { ViteManager } from "../vite-manager.js";
import { ClaudeProcess } from "../claude.js";
import { FileWatcher } from "../file-watcher.js";
import { ThreadManager } from "../threads.js";
import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubViteManager,
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  StubFileWatcher,
  waitForClaude,
} from "./test-helpers.js";

describe("Integration: Conversation threads & checkpoints", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let gitManager: GitManager;
  let sessionManager: SessionManager;
  let chatHistoryManager: ChatHistoryManager;
  let threadManager: ThreadManager;
  let lastClaude: FakeClaudeProcess = null as any;

  beforeEach(async () => {
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-threads-"));
    gitManager = new GitManager(tmpDir);
    await gitManager.init();

    sessionManager = new SessionManager(path.join(tmpDir, "sessions.json"));
    chatHistoryManager = new ChatHistoryManager(path.join(tmpDir, "chat-history"));
    threadManager = new ThreadManager(path.join(tmpDir, "threads"));

    app = await buildApp({
      gitManager,
      sessionManager,
      chatHistoryManager,
      threadManager,
      viteManager: new StubViteManager() as unknown as ViteManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      claudeFactory: () => {
        lastClaude = new FakeClaudeProcess();
        return lastClaude as unknown as ClaudeProcess;
      },
      fileWatcher: new StubFileWatcher() as unknown as FileWatcher,
      workspaceDir: tmpDir,
      serveStatic: false,
      startVite: false,
      portScanIntervalMs: 0,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const match = address.match(/:(\d+)$/);
    port = match ? Number(match[1]) : 0;
  });

  afterEach(async () => {
    await app.close();
    await new Promise((r) => setTimeout(r, 200));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // Ignore cleanup errors
    }
  });

  /** Drain initial connect messages (preview_status, buffered logs, etc.). */
  async function drainConnect(client: TestClient): Promise<void> {
    // The first non-log message on connect is preview_status
    await client.receiveSkipLogs(5000);
  }

  /**
   * Wait for a specific message type, skipping log_entry messages.
   * Returns the matching message or throws on timeout.
   */
  async function waitForMessage(client: TestClient, type: string, timeoutMs = 5000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        const msg = await client.receive(remaining);
        if (msg.type === type) return msg;
      } catch {
        break;
      }
    }
    throw new Error(`Never received ${type}`);
  }

  /**
   * Helper: send a message and complete the Claude turn.
   * Returns the session ID from the session_started event.
   */
  async function doMessageTurn(
    client: TestClient,
    text: string,
    sessionId?: string,
  ): Promise<string> {
    client.send({ type: "send_message", text, sessionId });
    const claude = await waitForClaude(() => lastClaude);

    // Simulate init event
    claude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "agent-session-1",
    });

    // Collect session ID from session_started
    let sid = sessionId;
    const sessionMsg = await waitForMessage(client, "session_started");
    if (!sid) {
      sid = sessionMsg.session.id;
    }
    if (!sid) throw new Error("Never received session_started");

    // Simulate assistant response
    claude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: `Response to: ${text}` }] },
    });

    // Complete the turn
    claude.finish("agent-session-1");

    // Drain all remaining messages for this turn (claude_event, result, done, git_committed, logs...)
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        const msg = await client.receive(500);
        // Stop after we've seen the git_committed (or timeout)
        if (msg.type === "git_committed") break;
      } catch {
        // Timeout on receive — we've drained everything
        break;
      }
    }

    return sid!;
  }

  // ---- list_threads ----

  it("list_threads returns error when no active session", async () => {
    const client = await TestClient.connect(port);
    await drainConnect(client);

    client.send({ type: "list_threads" } as any);
    const msg = await client.receiveSkipLogs();

    expect(msg).toMatchObject({
      type: "error",
      message: "No active session",
    });

    client.close();
  });

  it("list_threads returns threads after session established", async () => {
    const client = await TestClient.connect(port);
    await drainConnect(client);

    await doMessageTurn(client, "Hello");

    client.send({ type: "list_threads" } as any);
    const msg = await waitForMessage(client, "thread_list");

    expect(msg.threads).toHaveLength(1);
    expect(msg.threads[0].name).toBe("main");
    expect(msg.threads[0].isActive).toBe(true);
    expect(msg.activeThreadId).toBe(msg.threads[0].id);

    client.close();
  });

  // ---- create_checkpoint ----

  it("create_checkpoint returns error when no active session", async () => {
    const client = await TestClient.connect(port);
    await drainConnect(client);

    client.send({ type: "create_checkpoint" } as any);
    const msg = await client.receiveSkipLogs();

    expect(msg).toMatchObject({
      type: "error",
      message: "No active session",
    });

    client.close();
  });

  it("create_checkpoint creates checkpoint on active thread", async () => {
    const client = await TestClient.connect(port);
    await drainConnect(client);

    const sessionId = await doMessageTurn(client, "Build a todo app");

    client.send({ type: "create_checkpoint", label: "Before refactor" } as any);
    const msg = await waitForMessage(client, "checkpoint_created");

    expect(msg.checkpoint.label).toBe("Before refactor");
    expect(msg.checkpoint.sessionId).toBe(sessionId);
    expect(msg.checkpoint.messageIndex).toBeGreaterThan(0);
    expect(msg.threadId).toBeDefined();

    client.close();
  });

  it("create_checkpoint rejects label over 200 characters", async () => {
    const client = await TestClient.connect(port);
    await drainConnect(client);

    await doMessageTurn(client, "Hello");

    const longLabel = "x".repeat(201);
    client.send({ type: "create_checkpoint", label: longLabel } as any);
    const msg = await waitForMessage(client, "error");

    expect(msg.message).toBe("Checkpoint label too long (max 200 characters)");

    client.close();
  });

  // ---- fork_thread ----

  it("fork_thread creates new thread", async () => {
    const client = await TestClient.connect(port);
    await drainConnect(client);

    await doMessageTurn(client, "Build an app");

    // Create checkpoint
    client.send({ type: "create_checkpoint", label: "v1" } as any);
    const cpMsg = await waitForMessage(client, "checkpoint_created");
    const checkpointId = cpMsg.checkpoint.id;

    // Fork from it
    client.send({ type: "fork_thread", checkpointId } as any);
    const response = await client.receiveSkipLogs(5000);

    expect(response.type).toBe("thread_forked");
    if (response.type === "thread_forked") {
      expect(response.thread.name).toBe("Thread 1");
      expect(response.thread.parentCheckpointId).toBe(checkpointId);
      expect(response.thread.isActive).toBe(true);
      expect(Array.isArray(response.messages)).toBe(true);
    }

    client.close();
  });

  it("fork_thread returns error for unknown checkpoint", async () => {
    const client = await TestClient.connect(port);
    await drainConnect(client);

    await doMessageTurn(client, "Hello");

    client.send({
      type: "fork_thread",
      checkpointId: "nonexistent",
    } as any);

    const msg = await waitForMessage(client, "error");
    expect(msg.message).toBe("Checkpoint not found");

    client.close();
  });

  it("fork_thread returns error when no active session", async () => {
    const client = await TestClient.connect(port);
    await drainConnect(client);

    client.send({
      type: "fork_thread",
      checkpointId: "some-id",
    } as any);
    const msg = await client.receiveSkipLogs();

    expect(msg).toMatchObject({
      type: "error",
      message: "No active session",
    });

    client.close();
  });

  // ---- switch_thread ----

  it("switch_thread switches to an existing thread and returns messages", async () => {
    const client = await TestClient.connect(port);
    await drainConnect(client);

    await doMessageTurn(client, "Hello");

    // Get main thread ID
    client.send({ type: "list_threads" } as any);
    const listMsg = await waitForMessage(client, "thread_list");
    const mainThreadId = listMsg.threads[0].id;

    // Create checkpoint and fork
    client.send({ type: "create_checkpoint" } as any);
    const cpMsg = await waitForMessage(client, "checkpoint_created");

    client.send({ type: "fork_thread", checkpointId: cpMsg.checkpoint.id } as any);
    const forkResp = await client.receiveSkipLogs(5000);
    expect(forkResp.type).toBe("thread_forked");

    // Switch back to main
    client.send({ type: "switch_thread", threadId: mainThreadId } as any);
    const switchResp = await client.receiveSkipLogs(5000);

    expect(switchResp.type).toBe("thread_switched");
    if (switchResp.type === "thread_switched") {
      expect(switchResp.thread.name).toBe("main");
      expect(switchResp.thread.isActive).toBe(true);
      expect(Array.isArray(switchResp.messages)).toBe(true);
    }

    client.close();
  });

  it("switch_thread returns error for unknown thread", async () => {
    const client = await TestClient.connect(port);
    await drainConnect(client);

    await doMessageTurn(client, "Hello");

    client.send({
      type: "switch_thread",
      threadId: "nonexistent",
    } as any);

    const msg = await waitForMessage(client, "error");
    expect(msg.message).toBe("Thread not found");

    client.close();
  });

  it("switch_thread returns error when no active session", async () => {
    const client = await TestClient.connect(port);
    await drainConnect(client);

    client.send({
      type: "switch_thread",
      threadId: "some-id",
    } as any);
    const msg = await client.receiveSkipLogs();

    expect(msg).toMatchObject({
      type: "error",
      message: "No active session",
    });

    client.close();
  });

  // ---- Session lifecycle ----

  it("delete_session cleans up thread data", async () => {
    const client = await TestClient.connect(port);
    await drainConnect(client);

    const sessionId = await doMessageTurn(client, "Hello");

    // Create a checkpoint
    client.send({ type: "create_checkpoint" } as any);
    await waitForMessage(client, "checkpoint_created");

    // Verify thread data exists
    const beforeDelete = threadManager.listThreads(sessionId);
    expect(beforeDelete.threads[0].checkpoints).toHaveLength(1);

    // Delete the session
    client.send({ type: "delete_session", sessionId });
    await waitForMessage(client, "session_list");

    // Verify thread data is cleaned up (new load returns defaults)
    const afterDelete = threadManager.listThreads(sessionId);
    expect(afterDelete.threads[0].checkpoints).toHaveLength(0);

    client.close();
  });
});
