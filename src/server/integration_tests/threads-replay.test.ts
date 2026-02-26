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

describe("Integration: Threads — replay & lifecycle", () => {
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

  // ---- Conversation replay on fork ----

  it("fork_thread stores conversation replay for new thread", async () => {
    const client = await TestClient.connect(port);
    await drainConnect(client);

    const sessionId = await doMessageTurn(client, "Build a todo app");

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
    const forkResp = await client.receiveType("thread_forked", 5000);

    if (forkResp.type === "thread_forked") {
      // The new thread should have a conversation replay set on the server
      const activeThread = threadManager.getActiveThread(sessionId);
      expect(activeThread).toBeDefined();
      // Verify replay was set (peek at thread data without consuming)
      const data = threadManager.listThreads(sessionId);
      const forkedThread = data.threads.find((t) => t.id === forkResp.thread.id);
      expect(forkedThread?.conversationReplay).toBeDefined();
      expect(forkedThread?.conversationReplay).toContain("Build a todo app");
      expect(forkedThread?.conversationReplay).toContain("You are continuing a conversation");
    }

    client.close();
  });

  it("fork_thread with conversation replay: new message starts fresh session", async () => {
    const client = await TestClient.connect(port);
    await drainConnect(client);

    const sessionId = await doMessageTurn(client, "Build a todo app");

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

    // Now send a message on the forked thread — it should use the replay
    // as system prompt (no --resume) since this is a fresh CLI session.
    const prevClaude = lastClaude;
    client.send({ type: "send_message", text: "Add tests", sessionId } as any);
    const claude = await waitForClaude(() => lastClaude, prevClaude);

    // The replay should have been consumed and passed as system prompt
    expect(claude.lastSystemPrompt).toBeDefined();
    expect(claude.lastSystemPrompt).toContain("You are continuing a conversation");
    expect(claude.lastSystemPrompt).toContain("Build a todo app");
    // Should NOT resume an existing session (starts fresh)
    expect(claude.lastSessionId).toBeUndefined();

    // Clean up the Claude process
    claude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "agent-session-fork",
    });
    claude.finish("agent-session-fork");

    // Drain remaining messages
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try { await client.receive(200); } catch { break; }
    }

    // After consuming, replay should be cleared
    const data = threadManager.listThreads(sessionId);
    if (forkResp.type === "thread_forked") {
      const thread = data.threads.find((t) => t.id === forkResp.thread.id);
      expect(thread?.conversationReplay).toBeUndefined();
    }

    client.close();
  });

  // ---- Session lifecycle ----

  it("archive_session preserves thread data", async () => {
    const client = await TestClient.connect(port);
    await drainConnect(client);

    const sessionId = await doMessageTurn(client, "Hello");

    // Create a checkpoint via HTTP
    const cpRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/threads/checkpoint`,
      payload: {},
    });
    expect(cpRes.statusCode).toBe(200);

    // Verify thread data exists
    const beforeArchive = threadManager.listThreads(sessionId);
    expect(beforeArchive.threads[0].checkpoints).toHaveLength(1);

    // Archive the session via HTTP
    const archiveRes = await app.inject({ method: "DELETE", url: `/api/sessions/${sessionId}` });
    expect(archiveRes.statusCode).toBe(200);

    // Verify thread data is still present (archive preserves data)
    const afterArchive = threadManager.listThreads(sessionId);
    expect(afterArchive.threads[0].checkpoints).toHaveLength(1);

    client.close();
  });
});
