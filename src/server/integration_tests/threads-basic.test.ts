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
} from "./test-helpers.js";

describe("Integration: Threads — list & checkpoints", () => {
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

  /** Drain initial connect messages (preview_status, buffered logs, etc.). */
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

  // ---- list_threads ----

  it("list_threads returns 404 for nonexistent session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sessions/nonexistent/threads" });
    expect(res.statusCode).toBe(404);
  });

  it("list_threads returns threads after session established", async () => {
    const client = await TestClient.connect(port);
    await drainConnect(client);

    const sessionId = await doMessageTurn(client, "Hello");

    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/threads` });
    expect(res.statusCode).toBe(200);
    const msg = res.json();

    expect(msg.threads).toHaveLength(1);
    expect(msg.threads[0].name).toBe("main");
    expect(msg.threads[0].isActive).toBe(true);
    expect(msg.activeThreadId).toBe(msg.threads[0].id);

    client.close();
  });

});
