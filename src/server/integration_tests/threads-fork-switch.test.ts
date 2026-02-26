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
import { PreviewManager } from "../preview-manager.js";
import { ClaudeProcess } from "../claude.js";
import { FileWatcher } from "../file-watcher.js";
import { ThreadManager } from "../threads.js";
import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubPreviewManager,
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  StubFileWatcher,
  waitForClaude,
  createTestCredentialStore,
} from "./test-helpers.js";

describe("Integration: Threads — fork & switch", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let chatHistoryManager: ChatHistoryManager;
  let threadManager: ThreadManager;
  let lastClaude: FakeClaudeProcess = null as any;

  beforeEach(async () => {
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-threads-"));
    sessionManager = new SessionManager(path.join(tmpDir, "sessions.json"));
    chatHistoryManager = new ChatHistoryManager(path.join(tmpDir, "chat-history"));
    threadManager = new ThreadManager(path.join(tmpDir, "threads"));

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      chatHistoryManager,
      threadManager,
      previewManager: new StubPreviewManager() as unknown as PreviewManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      claudeFactory: () => {
        lastClaude = new FakeClaudeProcess();
        return lastClaude as unknown as ClaudeProcess;
      },
      fileWatcher: new StubFileWatcher() as unknown as FileWatcher,
      workspaceDir: tmpDir,
      serveStatic: false,
      startPreview: false,
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

  async function drainConnect(client: TestClient): Promise<void> {
    await client.receiveSkipLogs(5000);
  }

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

  async function doMessageTurn(
    client: TestClient,
    text: string,
    sessionId?: string,
  ): Promise<string> {
    client.send({ type: "send_message", text, sessionId });
    const claude = await waitForClaude(() => lastClaude);

    claude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "agent-session-1",
    });

    let sid = sessionId;
    const sessionMsg = await waitForMessage(client, "session_started");
    if (!sid) {
      sid = sessionMsg.session.id;
    }
    if (!sid) throw new Error("Never received session_started");

    claude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: `Response to: ${text}` }] },
    });

    claude.finish("agent-session-1");

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        const msg = await client.receive(500);
        if (msg.type === "git_committed") break;
      } catch {
        break;
      }
    }

    return sid!;
  }

  // ---- fork_thread ----

  it("fork_thread creates new thread", async () => {
    const client = await TestClient.connect(port);
    await drainConnect(client);

    const sessionId = await doMessageTurn(client, "Build an app");

    // Create checkpoint via HTTP
    const cpRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/threads/checkpoint`,
      payload: { label: "v1" },
    });
    expect(cpRes.statusCode).toBe(200);
    const checkpointId = cpRes.json().checkpoint.id;

    // Fork from it
    client.send({ type: "fork_thread", checkpointId } as any);
    const response = await client.receiveType("thread_forked", 5000);
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
    const msg = await client.receiveType("error");
    expect((msg as any).message).toBe("No active session");

    client.close();
  });

  // ---- switch_thread ----

  it("switch_thread switches to an existing thread and returns messages", async () => {
    const client = await TestClient.connect(port);
    await drainConnect(client);

    const sessionId = await doMessageTurn(client, "Hello");

    // Get main thread ID via HTTP
    const threadsRes = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/threads` });
    const listMsg = threadsRes.json();
    const mainThreadId = listMsg.threads[0].id;

    // Create checkpoint via HTTP and fork
    const cpRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/threads/checkpoint`,
      payload: {},
    });
    expect(cpRes.statusCode).toBe(200);
    const checkpointId = cpRes.json().checkpoint.id;

    client.send({ type: "fork_thread", checkpointId } as any);
    const forkResp = await client.receiveType("thread_forked", 5000);

    // Switch back to main
    client.send({ type: "switch_thread", threadId: mainThreadId } as any);
    const switchResp = await client.receiveType("thread_switched", 5000);
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
    const msg = await client.receiveType("error");
    expect((msg as any).message).toBe("No active session");

    client.close();
  });
});
