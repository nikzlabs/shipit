/**
 * Integration tests for the full WebSocket flow from client to server.
 *
 * These tests start a real Fastify server with mocked external dependencies
 * (ClaudeProcess, ViteManager) and connect real WebSocket clients to verify
 * the end-to-end message flow.
 *
 * Pattern:
 *   1. buildApp() with injected stubs (no child processes spawned)
 *   2. app.listen() on an ephemeral port
 *   3. Connect a TestClient (message-buffering WebSocket wrapper)
 *   4. Send JSON messages, assert responses via client.receive()
 *   5. app.close() to tear down
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { buildApp } from "./index.js";
import { GitManager } from "./git.js";
import { SessionManager } from "./sessions.js";
import { ChatHistoryManager } from "./chat-history.js";
import { AuthManager } from "./auth.js";
import { GitHubAuthManager } from "./github-auth.js";
import { ViteManager } from "./vite-manager.js";
import { ClaudeProcess } from "./claude.js";
import { FileWatcher } from "./file-watcher.js";
import type { WsServerMessage, WsClientMessage } from "./types.js";
import type { FastifyInstance } from "fastify";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * WebSocket test client that buffers all incoming messages from the moment
 * the connection opens. This avoids the race condition where the server sends
 * a message (e.g. preview_status) before the test sets up a listener.
 *
 * Usage:
 *   const client = await TestClient.connect(port);
 *   const msg = await client.receive();   // first buffered or next message
 *   client.send({ type: "list_sessions" });
 *   const resp = await client.receive();
 *   client.close();
 */
class TestClient {
  private ws: WebSocket;
  private queue: WsServerMessage[] = [];
  private waiters: Array<(msg: WsServerMessage) => void> = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data: WebSocket.Data) => {
      const msg: WsServerMessage = JSON.parse(data.toString());
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter(msg);
      } else {
        this.queue.push(msg);
      }
    });
  }

  /** Connect to the server and start buffering messages immediately. */
  static connect(port: number): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      // Create client before open so message listener is attached early
      const client = new TestClient(ws);
      ws.on("open", () => resolve(client));
      ws.on("error", reject);
    });
  }

  /** Get the next message — returns from buffer or waits for one. */
  receive(timeoutMs = 3000): Promise<WsServerMessage> {
    const buffered = this.queue.shift();
    if (buffered) return Promise.resolve(buffered);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`TestClient.receive() timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      this.waiters.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  }

  /** Collect exactly N messages. */
  async receiveN(count: number): Promise<WsServerMessage[]> {
    const msgs: WsServerMessage[] = [];
    for (let i = 0; i < count; i++) {
      msgs.push(await this.receive());
    }
    return msgs;
  }

  /** Get the next message that is NOT a log_entry — useful for tests that predate the terminal feature. */
  async receiveSkipLogs(timeoutMs = 3000): Promise<WsServerMessage> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("receiveSkipLogs() timed out");
      const msg = await this.receive(remaining);
      if (msg.type !== "log_entry") return msg;
    }
  }

  /** Send a typed client message. */
  send(msg: WsClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** Send raw string data (for invalid-JSON tests). */
  sendRaw(data: string): void {
    this.ws.send(data);
  }

  /** Close the connection. */
  close(): void {
    this.ws.close();
  }

  get readyState(): number {
    return this.ws.readyState;
  }
}

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

/**
 * Stub ViteManager that never spawns a process.
 * Reports as not running with port 5173 (matching production defaults).
 */
class StubViteManager extends EventEmitter {
  private _running = false;
  private _port = 5173;
  get running() { return this._running; }
  get port() { return this._port; }
  start() { /* no-op */ }
  stop() { /* no-op */ }
  restart() { /* no-op */ }
}

/**
 * Stub AuthManager that never spawns a process.
 * checkCredentials() always returns false.
 */
class StubAuthManager extends EventEmitter {
  checkCredentials() { return false; }
  startOAuthFlow() { /* no-op */ }
  kill() { /* no-op */ }
}

/**
 * Stub GitHubAuthManager for testing GitHub auth flow.
 * Does not make real API calls or touch the filesystem.
 */
class StubGitHubAuthManager extends EventEmitter {
  private _authenticated = false;
  private _username: string | null = null;
  checkCredentials() { return this._authenticated; }
  get authenticated() { return this._authenticated; }
  getStatus() {
    return {
      authenticated: this._authenticated,
      username: this._username ?? undefined,
      avatarUrl: undefined,
    };
  }
  async setToken(token: string) {
    if (!token.trim()) {
      this.emit("auth_failed", "Token cannot be empty");
      return false;
    }
    // Accept any non-empty token in tests
    this._authenticated = true;
    this._username = "test-user";
    this.emit("auth_complete");
    return true;
  }
  clearCredentials() {
    this._authenticated = false;
    this._username = null;
  }
  configureGitCredentials() { /* no-op */ }
  async loadUserInfo() { /* no-op */ }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async createRepo(name: string, options: { description?: string; isPrivate?: boolean } = {}) {
    return {
      success: true,
      name,
      fullName: `test-user/${name}`,
      url: `https://github.com/test-user/${name}`,
      cloneUrl: `https://github.com/test-user/${name}.git`,
    };
  }
}

/**
 * Fake ClaudeProcess for testing the send_message flow.
 * The test controls this object: call emit("event", ...) or emit("done", ...)
 * to simulate the real CLI producing output.
 */
class FakeClaudeProcess extends EventEmitter {
  public runCalled = false;
  public lastPrompt = "";
  public lastSessionId: string | undefined;
  public lastSystemPrompt: string | undefined;
  public lastImages: Array<{ data: string; mediaType: string; filename?: string }> | undefined;
  public killed = false;
  public stdinData: string[] = [];

  run(prompt: string, sessionId?: string, systemPrompt?: string, images?: Array<{ data: string; mediaType: string; filename?: string }>) {
    this.runCalled = true;
    this.lastPrompt = prompt;
    this.lastSessionId = sessionId;
    this.lastSystemPrompt = systemPrompt;
    this.lastImages = images;
  }

  kill() {
    this.killed = true;
  }

  writeStdin(data: string) {
    this.stdinData.push(data);
  }
}

/**
 * Stub FileWatcher that doesn't actually watch the filesystem.
 * Tests can call simulateChanges() to trigger "changes" events manually.
 */
class StubFileWatcher extends EventEmitter {
  start() { /* no-op */ }
  stop() { /* no-op */ }
  simulateChanges(paths: string[]) {
    this.emit("changes", paths);
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Integration: WebSocket flow", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let gitManager: GitManager;
  let sessionManager: SessionManager;
  /** Most recently created FakeClaudeProcess — set by claudeFactory. */
  let lastClaude: FakeClaudeProcess;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-integration-"));

    // Create a markdown file for doc tests
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# Hello\nWorld");

    gitManager = new GitManager(tmpDir);
    await gitManager.init();

    const sessionsFile = path.join(tmpDir, "sessions.json");
    sessionManager = new SessionManager(sessionsFile);

    app = await buildApp({
      gitManager,
      sessionManager,
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
      portScanIntervalMs: 0, // disable periodic scanning for these tests
    });

    // Listen on port 0 to get an ephemeral port
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const match = address.match(/:(\d+)$/);
    port = match ? Number(match[1]) : 0;
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---- Connection ----

  it("sends preview_status on connect", async () => {
    const client = await TestClient.connect(port);
    const msg = await client.receive();

    expect(msg).toMatchObject({
      type: "preview_status",
      running: false,
      port: 5173,
    });

    client.close();
  });

  // ---- Invalid JSON ----

  it("returns error for invalid JSON", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // consume preview_status

    client.sendRaw("not valid json {{{");
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("Invalid JSON");

    client.close();
  });

  // ---- Session management ----

  it("list_sessions returns empty list initially", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "list_sessions" });
    const msg = await client.receive();

    expect(msg.type).toBe("session_list");
    expect((msg as any).sessions).toEqual([]);

    client.close();
  });

  it("new_session returns session list", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "new_session" });
    const msg = await client.receive();

    expect(msg.type).toBe("session_list");

    client.close();
  });

  it("delete_session removes a session", async () => {
    // Pre-populate a session
    sessionManager.track("sess-1", "Test session");

    const client = await TestClient.connect(port);
    await client.receive();

    // Verify it exists
    client.send({ type: "list_sessions" });
    const listMsg = await client.receive();
    expect((listMsg as any).sessions).toHaveLength(1);

    // Delete it
    client.send({ type: "delete_session", sessionId: "sess-1" });
    const deleteMsg = await client.receive();
    expect(deleteMsg.type).toBe("session_list");
    expect((deleteMsg as any).sessions).toHaveLength(0);

    client.close();
  });

  it("rename_session renames a session and returns updated session", async () => {
    sessionManager.track("sess-1", "Original title");

    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "rename_session", sessionId: "sess-1", title: "New title" });
    const msg = await client.receive();

    expect(msg.type).toBe("session_renamed");
    expect((msg as any).session.id).toBe("sess-1");
    expect((msg as any).session.title).toBe("New title");

    // Verify the session was actually renamed in the manager
    const sessions = sessionManager.list();
    expect(sessions[0].title).toBe("New title");

    client.close();
  });

  it("rename_session returns error for non-existent session", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "rename_session", sessionId: "nonexistent", title: "Nope" });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("Session not found");

    client.close();
  });

  it("rename_session rejects empty title", async () => {
    sessionManager.track("sess-1", "Original title");

    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "rename_session", sessionId: "sess-1", title: "   " });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("Session title cannot be empty");

    // Verify the title was NOT changed
    expect(sessionManager.list()[0].title).toBe("Original title");

    client.close();
  });

  // ---- Git operations ----

  it("get_git_log returns commit history", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "get_git_log" });
    const msg = await client.receive();

    expect(msg.type).toBe("git_log");
    const commits = (msg as any).commits;
    expect(commits.length).toBeGreaterThanOrEqual(1);
    expect(commits[0].message).toBe("Initial commit");

    client.close();
  });

  it("rollback resets to a previous commit", async () => {
    // Create a file and commit it
    fs.writeFileSync(path.join(tmpDir, "rollback-test.txt"), "original");
    await gitManager.autoCommit("Add rollback-test");

    const log = await gitManager.log();
    const initialHash = log[log.length - 1].hash; // "Initial commit"

    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "rollback", commitHash: initialHash });
    const msg = await client.receive();

    expect(msg.type).toBe("rollback_complete");
    expect((msg as any).commitHash).toBe(initialHash);

    // File should be gone after rollback
    expect(fs.existsSync(path.join(tmpDir, "rollback-test.txt"))).toBe(false);

    client.close();
  });

  // ---- Docs ----

  it("list_docs returns markdown files in workspace", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "list_docs" });
    const msg = await client.receive();

    expect(msg.type).toBe("doc_list");
    expect((msg as any).files).toContain("README.md");

    client.close();
  });

  it("get_doc returns file content", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "get_doc", path: "README.md" });
    const msg = await client.receive();

    expect(msg.type).toBe("doc_content");
    expect((msg as any).path).toBe("README.md");
    expect((msg as any).content).toBe("# Hello\nWorld");

    client.close();
  });

  it("get_doc rejects path traversal", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "get_doc", path: "../../etc/passwd" });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("Invalid path");

    client.close();
  });

  it("get_doc returns error for non-existent file", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "get_doc", path: "does-not-exist.md" });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toContain("Failed to read doc");

    client.close();
  });

  // ---- File content viewer ----

  it("get_file_content returns file content", async () => {
    fs.writeFileSync(path.join(tmpDir, "hello.ts"), "const x = 42;");

    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "get_file_content", path: "hello.ts" });
    const msg = await client.receive();

    expect(msg.type).toBe("file_content");
    expect((msg as any).path).toBe("hello.ts");
    expect((msg as any).content).toBe("const x = 42;");

    client.close();
  });

  it("get_file_content returns nested file content", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "app.ts"), "export default {};");

    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "get_file_content", path: "src/app.ts" });
    const msg = await client.receive();

    expect(msg.type).toBe("file_content");
    expect((msg as any).path).toBe("src/app.ts");
    expect((msg as any).content).toBe("export default {};");

    client.close();
  });

  it("get_file_content rejects path traversal", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "get_file_content", path: "../../etc/passwd" });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("Invalid path");

    client.close();
  });

  it("get_file_content returns error for non-existent file", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "get_file_content", path: "no-such-file.ts" });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toContain("Failed to read file");

    client.close();
  });

  it("get_file_content returns isBinary for binary files", async () => {
    // Write a file with null bytes (binary indicator)
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]);
    fs.writeFileSync(path.join(tmpDir, "image.png"), buf);

    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "get_file_content", path: "image.png" });
    const msg = await client.receive();

    expect(msg.type).toBe("file_content");
    expect((msg as any).isBinary).toBe(true);
    expect((msg as any).content).toContain("Binary file");

    client.close();
  });

  it("get_file_content returns isBinary for large files", async () => {
    // Write a file over 1 MB
    const bigContent = "x".repeat(1_048_577);
    fs.writeFileSync(path.join(tmpDir, "big.txt"), bigContent);

    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "get_file_content", path: "big.txt" });
    const msg = await client.receive();

    expect(msg.type).toBe("file_content");
    expect((msg as any).isBinary).toBe(true);
    expect((msg as any).content).toContain("too large");

    client.close();
  });

  // ---- Claude message flow ----

  it("send_message creates a ClaudeProcess and relays events", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "Hello Claude" });

    // Wait a tick for the claudeFactory to be called
    await new Promise((r) => setTimeout(r, 50));

    expect(lastClaude.runCalled).toBe(true);
    expect(lastClaude.lastPrompt).toBe("Hello Claude");

    // Simulate Claude emitting a system init event
    lastClaude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "test-session-123",
      tools: ["Write"],
    });

    // Should receive claude_event + session_started (skip any log_entry messages)
    const claudeEvent = await client.receiveSkipLogs();
    expect(claudeEvent).toBeDefined();
    expect(claudeEvent.type).toBe("claude_event");
    expect((claudeEvent as any).event.type).toBe("system");

    const sessionStarted = await client.receiveSkipLogs();
    expect(sessionStarted).toBeDefined();
    expect(sessionStarted.type).toBe("session_started");
    expect((sessionStarted as any).session.id).toBe("test-session-123");
    expect((sessionStarted as any).session.title).toBe("Hello Claude");

    client.close();
  });

  it("send_message with sessionId passes it to ClaudeProcess.run()", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Resume", sessionId: "existing-session" });

    await new Promise((r) => setTimeout(r, 50));

    expect(lastClaude.lastSessionId).toBe("existing-session");

    client.close();
  });

  it("claude done event triggers git auto-commit", async () => {
    // Create a file that will be committed on done
    fs.writeFileSync(path.join(tmpDir, "new-file.txt"), "auto commit me");

    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Make a file" });
    await new Promise((r) => setTimeout(r, 50));

    // Simulate assistant text (used as commit message)
    lastClaude.emit("event", {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "I created new-file.txt for you" }],
      },
    });

    // Consume the claude_event for the assistant message (skip log_entry messages)
    await client.receiveSkipLogs();

    // Now simulate done — this triggers auto-commit
    lastClaude.emit("done", 0);

    // Wait for the async auto-commit (skip log_entry messages)
    const msg = await client.receiveSkipLogs();

    expect(msg.type).toBe("git_committed");
    expect((msg as any).message).toBe("I created new-file.txt for you");
    expect((msg as any).hash).toBeTruthy();

    client.close();
  });

  it("claude error event is relayed to client", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "fail" });
    await new Promise((r) => setTimeout(r, 50));

    lastClaude.emit("error", new Error("spawn ENOENT"));

    // Skip log_entry messages to get the error
    const msg = await client.receiveSkipLogs();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toContain("Claude process error");
    expect((msg as any).message).toContain("spawn ENOENT");

    client.close();
  });

  it("sending a new message kills the previous ClaudeProcess", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    // First message
    client.send({ type: "send_message", text: "First" });
    await new Promise((r) => setTimeout(r, 50));
    const firstClaude = lastClaude;

    // Second message before first completes
    client.send({ type: "send_message", text: "Second" });
    await new Promise((r) => setTimeout(r, 50));

    expect(firstClaude.killed).toBe(true);
    expect(lastClaude.lastPrompt).toBe("Second");
    expect(lastClaude).not.toBe(firstClaude);

    client.close();
  });

  // ---- Multiple clients ----

  it("multiple clients each receive their own preview_status on connect", async () => {
    const client1 = await TestClient.connect(port);
    const msg1 = await client1.receive();
    expect(msg1.type).toBe("preview_status");

    const client2 = await TestClient.connect(port);
    const msg2 = await client2.receive();
    expect(msg2.type).toBe("preview_status");

    client1.close();
    client2.close();
  });

  // ---- Disconnect cleanup ----

  it("disconnecting kills any running ClaudeProcess", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "test" });
    await new Promise((r) => setTimeout(r, 50));
    const claude = lastClaude;

    // Close the websocket — should kill the process
    client.close();
    await new Promise((r) => setTimeout(r, 100));

    expect(claude.killed).toBe(true);
  });

  // ---- Result event tracking ----

  it("result event updates session lastUsedAt", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "test" });
    await new Promise((r) => setTimeout(r, 50));

    // Init event creates the session
    lastClaude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "track-session",
    });
    // Consume claude_event + session_started (skip log_entry messages)
    await client.receiveSkipLogs(); // claude_event
    await client.receiveSkipLogs(); // session_started

    const sessionsBefore = sessionManager.list();
    const lastUsedBefore = sessionsBefore[0].lastUsedAt;

    // Wait a tick so timestamp differs
    await new Promise((r) => setTimeout(r, 10));

    // Result event should update lastUsedAt
    lastClaude.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "track-session",
    });
    // Consume the claude_event (skip log_entry messages)
    await client.receiveSkipLogs();

    const sessionsAfter = sessionManager.list();
    expect(sessionsAfter[0].lastUsedAt >= lastUsedBefore).toBe(true);

    client.close();
  });

  // ---- AskUserQuestion / answer_question flow ----

  it("answer_question writes to stdin when Claude process is running", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Start a Claude message flow
    client.send({ type: "send_message", text: "Ask me something" });
    await new Promise((r) => setTimeout(r, 50));

    // Claude is now running — send an answer
    client.send({ type: "answer_question", toolUseId: "tool-1", answers: { "0": "Redis" } });
    await new Promise((r) => setTimeout(r, 50));

    expect(lastClaude.stdinData).toEqual(["Redis\n"]);

    client.close();
  });

  it("answer_question starts new Claude process when no process is running", async () => {
    // Pre-populate a session so we can resume
    sessionManager.track("existing-sess", "Test session");

    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Start and immediately finish a Claude turn to set currentSessionId
    client.send({ type: "send_message", text: "First message", sessionId: "existing-sess" });
    await new Promise((r) => setTimeout(r, 50));
    const firstClaude = lastClaude;

    // Simulate Claude finishing
    firstClaude.emit("done", 0);
    await new Promise((r) => setTimeout(r, 100));

    // Now Claude is null — send an answer
    client.send({ type: "answer_question", toolUseId: "tool-2", answers: { "0": "PostgreSQL" } });
    await new Promise((r) => setTimeout(r, 50));

    // A new ClaudeProcess should have been created
    expect(lastClaude).not.toBe(firstClaude);
    expect(lastClaude.runCalled).toBe(true);
    expect(lastClaude.lastPrompt).toBe("PostgreSQL");
    expect(lastClaude.lastSessionId).toBe("existing-sess");

    client.close();
  });

  it("answer_question returns error for empty answer", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "answer_question", toolUseId: "tool-3", answers: {} });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("Answer cannot be empty");

    client.close();
  });

  it("answer_question with multiple answers joins them", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Start a Claude message flow
    client.send({ type: "send_message", text: "test" });
    await new Promise((r) => setTimeout(r, 50));

    // Send an answer with multiple values
    client.send({
      type: "answer_question",
      toolUseId: "tool-4",
      answers: { "0": "Auth", "1": "Cache" },
    });
    await new Promise((r) => setTimeout(r, 50));

    // Should write both answers joined by comma
    expect(lastClaude.stdinData).toEqual(["Auth, Cache\n"]);

    client.close();
  });
});

// ---------------------------------------------------------------------------
// Port auto-detection tests
// ---------------------------------------------------------------------------

describe("Integration: Port auto-detection", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let gitManager: GitManager;
  let sessionManager: SessionManager;
  let lastClaude: FakeClaudeProcess;
  /** Value returned by the injected detectPorts stub. */
  let stubDetectedPorts: number[];

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-portdetect-"));

    gitManager = new GitManager(tmpDir);
    await gitManager.init();

    const sessionsFile = path.join(tmpDir, "sessions.json");
    sessionManager = new SessionManager(sessionsFile);

    stubDetectedPorts = [];

    app = await buildApp({
      gitManager,
      sessionManager,
      viteManager: new StubViteManager() as unknown as ViteManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      claudeFactory: () => {
        lastClaude = new FakeClaudeProcess();
        return lastClaude as unknown as ClaudeProcess;
      },
      detectPorts: async () => stubDetectedPorts,
      fileWatcher: new StubFileWatcher() as unknown as FileWatcher,
      workspaceDir: tmpDir,
      serveStatic: false,
      startVite: false,
      portScanIntervalMs: 0, // disable periodic scanning for these tests
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const match = address.match(/:(\d+)$/);
    port = match ? Number(match[1]) : 0;
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("broadcasts detected port after Claude turn completes", async () => {
    // Simulate a dev server on port 3001
    stubDetectedPorts = [3001];

    const client = await TestClient.connect(port);
    // Consume initial preview_status (not running, no detected port yet)
    const initialStatus = await client.receive();
    expect(initialStatus).toMatchObject({ type: "preview_status", running: false });

    // Start a Claude message flow
    client.send({ type: "send_message", text: "Start a server" });
    await new Promise((r) => setTimeout(r, 50));

    // Simulate Claude finishing
    lastClaude.emit("done", 0);

    // Should receive preview_status with the detected port
    // (may also receive git_committed if there were changes — drain until preview_status)
    let previewMsg: any = null;
    for (let i = 0; i < 5; i++) {
      const msg = await client.receive();
      if (msg.type === "preview_status") {
        previewMsg = msg;
        break;
      }
    }

    expect(previewMsg).not.toBeNull();
    expect(previewMsg).toMatchObject({
      type: "preview_status",
      running: true,
      port: 3001,
      source: "detected",
      detectedPorts: [3001],
    });
    expect(previewMsg.url).toBe("http://localhost:3001");

    client.close();
  });

  it("does not broadcast when no port is detected", async () => {
    stubDetectedPorts = [];

    const client = await TestClient.connect(port);
    await client.receive(); // initial preview_status

    client.send({ type: "send_message", text: "No server" });
    await new Promise((r) => setTimeout(r, 50));

    lastClaude.emit("done", 0);

    // Wait a bit — we should NOT receive a preview_status update
    // The only message we might get is git_committed (if there were changes)
    await new Promise((r) => setTimeout(r, 200));

    // Drain any remaining messages — none should be preview_status with running=true
    const remaining: any[] = [];
    try {
      while (true) {
        remaining.push(await client.receive(100));
      }
    } catch {
      // Timeout = no more messages, which is expected
    }

    const previewMsgs = remaining.filter(
      (m) => m.type === "preview_status" && m.running === true,
    );
    expect(previewMsgs).toHaveLength(0);

    client.close();
  });

  it("updates preview when detected port changes between turns", async () => {
    stubDetectedPorts = [8080];

    const client = await TestClient.connect(port);
    await client.receive(); // initial preview_status

    // First turn — detect port 8080
    client.send({ type: "send_message", text: "Start server" });
    await new Promise((r) => setTimeout(r, 50));
    lastClaude.emit("done", 0);

    let previewMsg: any = null;
    for (let i = 0; i < 5; i++) {
      const msg = await client.receive();
      if (msg.type === "preview_status") {
        previewMsg = msg;
        break;
      }
    }
    expect(previewMsg.port).toBe(8080);

    // Second turn — port changes to 4000
    stubDetectedPorts = [4000];
    client.send({ type: "send_message", text: "Change server" });
    await new Promise((r) => setTimeout(r, 50));
    lastClaude.emit("done", 0);

    let updatedMsg: any = null;
    for (let i = 0; i < 5; i++) {
      const msg = await client.receive();
      if (msg.type === "preview_status") {
        updatedMsg = msg;
        break;
      }
    }
    expect(updatedMsg.port).toBe(4000);
    expect(updatedMsg.source).toBe("detected");

    client.close();
  });

  it("new client receives current detected port on connect", async () => {
    stubDetectedPorts = [3001];

    const client1 = await TestClient.connect(port);
    await client1.receive(); // initial preview_status (not running yet)

    // Trigger a Claude turn to detect the port
    client1.send({ type: "send_message", text: "Go" });
    await new Promise((r) => setTimeout(r, 50));
    lastClaude.emit("done", 0);

    // Drain messages until we see the updated preview_status
    for (let i = 0; i < 5; i++) {
      const msg = await client1.receive();
      if (msg.type === "preview_status" && (msg as any).running) break;
    }

    // Now a second client connects — should receive the detected port immediately
    const client2 = await TestClient.connect(port);
    const msg = await client2.receive();

    expect(msg).toMatchObject({
      type: "preview_status",
      running: true,
      port: 3001,
      source: "detected",
    });

    client1.close();
    client2.close();
  });

  it("broadcasts all detected ports when multiple servers are running", async () => {
    stubDetectedPorts = [3001, 8080];

    const client = await TestClient.connect(port);
    await client.receive(); // initial preview_status

    client.send({ type: "send_message", text: "Start servers" });
    await new Promise((r) => setTimeout(r, 50));
    lastClaude.emit("done", 0);

    let previewMsg: any = null;
    for (let i = 0; i < 5; i++) {
      const msg = await client.receive();
      if (msg.type === "preview_status") {
        previewMsg = msg;
        break;
      }
    }

    expect(previewMsg).not.toBeNull();
    expect(previewMsg).toMatchObject({
      type: "preview_status",
      running: true,
      port: 3001,
      source: "detected",
      detectedPorts: [3001, 8080],
    });

    client.close();
  });
});

// ---------------------------------------------------------------------------
// Periodic port scanning tests
// ---------------------------------------------------------------------------

describe("Integration: Periodic port scanning", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let gitManager: GitManager;
  let sessionManager: SessionManager;
  let lastClaude: FakeClaudeProcess;
  /** Value returned by the injected detectPorts stub. */
  let stubDetectedPorts: number[];
  /** Count how many times detectPorts was called. */
  let detectPortsCallCount: number;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-periodic-"));

    gitManager = new GitManager(tmpDir);
    await gitManager.init();

    const sessionsFile = path.join(tmpDir, "sessions.json");
    sessionManager = new SessionManager(sessionsFile);

    stubDetectedPorts = [];
    detectPortsCallCount = 0;

    app = await buildApp({
      gitManager,
      sessionManager,
      viteManager: new StubViteManager() as unknown as ViteManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      claudeFactory: () => {
        lastClaude = new FakeClaudeProcess();
        return lastClaude as unknown as ClaudeProcess;
      },
      detectPorts: async () => {
        detectPortsCallCount++;
        return stubDetectedPorts;
      },
      fileWatcher: new StubFileWatcher() as unknown as FileWatcher,
      workspaceDir: tmpDir,
      serveStatic: false,
      startVite: false,
      portScanIntervalMs: 200, // fast interval for testing
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const match = address.match(/:(\d+)$/);
    port = match ? Number(match[1]) : 0;
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects a port started mid-turn without waiting for Claude to finish", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // initial preview_status (not running)

    // Start a Claude message flow (Claude is still running)
    client.send({ type: "send_message", text: "Start a server" });
    await new Promise((r) => setTimeout(r, 50));

    // Simulate a server starting mid-turn (before Claude finishes)
    stubDetectedPorts = [8080];

    // Wait for the periodic scanner to fire (interval is 200ms)
    let previewMsg: any = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((r) => setTimeout(r, 100));
      // Check if a preview_status message arrived
      try {
        const msg = await client.receive(150);
        if (msg.type === "preview_status" && (msg as any).running) {
          previewMsg = msg;
          break;
        }
      } catch {
        // timeout — no message yet, keep waiting
      }
    }

    expect(previewMsg).not.toBeNull();
    expect(previewMsg).toMatchObject({
      type: "preview_status",
      running: true,
      port: 8080,
      source: "detected",
      detectedPorts: [8080],
    });

    // Claude is still running — we haven't emitted "done" yet
    expect(lastClaude.killed).toBe(false);

    client.close();
  });

  it("starts scanning when a client connects and stops when it disconnects", async () => {
    const countBefore = detectPortsCallCount;

    const client = await TestClient.connect(port);
    await client.receive(); // initial preview_status

    // Wait for at least two scan intervals
    await new Promise((r) => setTimeout(r, 500));
    const countDuringConnection = detectPortsCallCount - countBefore;
    expect(countDuringConnection).toBeGreaterThanOrEqual(2);

    // Disconnect
    client.close();
    await new Promise((r) => setTimeout(r, 100));

    // Record count after disconnect and wait — should not increase
    const countAfterDisconnect = detectPortsCallCount;
    await new Promise((r) => setTimeout(r, 400));
    expect(detectPortsCallCount).toBe(countAfterDisconnect);
  });

  it("does not broadcast when periodic scan finds no change", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // initial preview_status

    // No ports detected (stubDetectedPorts is [])
    // Wait several scan intervals
    await new Promise((r) => setTimeout(r, 500));

    // Should not have received any additional preview_status messages
    const remaining: any[] = [];
    try {
      while (true) {
        remaining.push(await client.receive(100));
      }
    } catch {
      // timeout — expected
    }

    const previewMsgs = remaining.filter(
      (m) => m.type === "preview_status" && m.running === true,
    );
    expect(previewMsgs).toHaveLength(0);

    client.close();
  });

  it("broadcasts when periodic scan detects port change", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // initial preview_status

    // After a couple of scans, make a port appear
    await new Promise((r) => setTimeout(r, 300));
    stubDetectedPorts = [3001];

    // Wait for the scanner to pick it up
    let previewMsg: any = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const msg = await client.receive(150);
        if (msg.type === "preview_status" && (msg as any).running) {
          previewMsg = msg;
          break;
        }
      } catch {
        // keep waiting
      }
    }

    expect(previewMsg).not.toBeNull();
    expect(previewMsg).toMatchObject({
      type: "preview_status",
      running: true,
      port: 3001,
      source: "detected",
    });

    // Now the port goes away
    stubDetectedPorts = [];

    let stoppedMsg: any = null;
    for (let attempt = 0; attempt < 15; attempt++) {
      try {
        const msg = await client.receive(250);
        if (msg.type === "preview_status" && !(msg as any).running) {
          stoppedMsg = msg;
          break;
        }
      } catch {
        // keep waiting
      }
    }

    expect(stoppedMsg).not.toBeNull();
    expect(stoppedMsg).toMatchObject({
      type: "preview_status",
      running: false,
    });

    client.close();
  });
});

// ---------------------------------------------------------------------------
// Terminal/logs relay tests
// ---------------------------------------------------------------------------

describe("Integration: Terminal/logs relay", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let gitManager: GitManager;
  let sessionManager: SessionManager;
  let lastClaude: FakeClaudeProcess;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-logs-"));

    gitManager = new GitManager(tmpDir);
    await gitManager.init();

    const sessionsFile = path.join(tmpDir, "sessions.json");
    sessionManager = new SessionManager(sessionsFile);

    app = await buildApp({
      gitManager,
      sessionManager,
      viteManager: new StubViteManager() as unknown as ViteManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
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
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("relays Claude stderr as log_entry to client", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "test" });
    await new Promise((r) => setTimeout(r, 50));

    // Consume the server "Claude process started" log entry
    const startLog = await client.receive();
    expect(startLog.type).toBe("log_entry");
    expect((startLog as any).source).toBe("server");

    // Simulate stderr from Claude CLI
    lastClaude.emit("log", "stderr", "Debug: loading model");

    const msg = await client.receive();
    expect(msg.type).toBe("log_entry");
    expect((msg as any).source).toBe("stderr");
    expect((msg as any).text).toBe("Debug: loading model");
    expect((msg as any).timestamp).toBeTruthy();

    client.close();
  });

  it("relays non-JSON stdout as log_entry to client", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "test" });
    await new Promise((r) => setTimeout(r, 50));

    // Consume "Claude process started" log entry
    await client.receive();

    // Simulate non-JSON stdout from Claude CLI
    lastClaude.emit("log", "stdout", "Warning: experimental feature");

    const msg = await client.receive();
    expect(msg.type).toBe("log_entry");
    expect((msg as any).source).toBe("stdout");
    expect((msg as any).text).toBe("Warning: experimental feature");

    client.close();
  });

  it("sends server lifecycle log entries (process start/exit)", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "test" });
    await new Promise((r) => setTimeout(r, 50));

    // Should receive "Claude process started" log
    const startLog = await client.receive();
    expect(startLog.type).toBe("log_entry");
    expect((startLog as any).source).toBe("server");
    expect((startLog as any).text).toBe("Claude process started");

    // Simulate Claude finishing
    lastClaude.emit("done", 0);

    // Should receive "Claude process exited" log
    // (may also receive git_committed — drain until we find the exit log)
    let exitLog: any = null;
    for (let i = 0; i < 5; i++) {
      const msg = await client.receive();
      if (msg.type === "log_entry" && (msg as any).text.includes("exited")) {
        exitLog = msg;
        break;
      }
    }

    expect(exitLog).not.toBeNull();
    expect(exitLog.source).toBe("server");
    expect(exitLog.text).toBe("Claude process exited with code 0");

    client.close();
  });

  it("sends buffered logs to newly connected clients", async () => {
    // First client triggers some log entries
    const client1 = await TestClient.connect(port);
    await client1.receive(); // preview_status

    client1.send({ type: "send_message", text: "generate logs" });
    await new Promise((r) => setTimeout(r, 50));

    // Consume the "Claude process started" log
    await client1.receive();

    // Add more logs via CLI output
    lastClaude.emit("log", "stderr", "Loading model...");
    await client1.receive(); // consume the stderr log

    // Now a second client connects — should receive buffered logs
    const client2 = await TestClient.connect(port);
    const preview = await client2.receive(); // preview_status
    expect(preview.type).toBe("preview_status");

    // Should receive the buffered log entries
    const log1 = await client2.receive();
    expect(log1.type).toBe("log_entry");
    expect((log1 as any).text).toBe("Claude process started");

    const log2 = await client2.receive();
    expect(log2.type).toBe("log_entry");
    expect((log2 as any).text).toBe("Loading model...");

    client1.close();
    client2.close();
  });

  it("clear_logs empties the log buffer", async () => {
    // Generate some logs
    const client1 = await TestClient.connect(port);
    await client1.receive(); // preview_status

    client1.send({ type: "send_message", text: "test" });
    await new Promise((r) => setTimeout(r, 50));
    await client1.receive(); // "Claude process started" log

    // Clear logs
    client1.send({ type: "clear_logs" });
    await new Promise((r) => setTimeout(r, 50));

    // New client should not receive any buffered logs
    const client2 = await TestClient.connect(port);
    const preview = await client2.receive(); // preview_status
    expect(preview.type).toBe("preview_status");

    // Wait a bit — should not receive any log entries
    let gotLog = false;
    try {
      const msg = await client2.receive(200);
      if (msg.type === "log_entry") gotLog = true;
    } catch {
      // Timeout — expected, no logs to receive
    }
    expect(gotLog).toBe(false);

    client1.close();
    client2.close();
  });
});

// ---------------------------------------------------------------------------
// Workspace project templates tests
// ---------------------------------------------------------------------------

describe("Integration: Workspace project templates", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let gitManager: GitManager;
  let sessionManager: SessionManager;
  let lastClaude: FakeClaudeProcess;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-templates-"));

    gitManager = new GitManager(tmpDir);
    await gitManager.init();

    const sessionsFile = path.join(tmpDir, "sessions.json");
    sessionManager = new SessionManager(sessionsFile);

    app = await buildApp({
      gitManager,
      sessionManager,
      viteManager: new StubViteManager() as unknown as ViteManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
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
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("list_templates returns all available templates", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "list_templates" });
    const msg = await client.receive();

    expect(msg.type).toBe("template_list");
    const templates = (msg as any).templates;
    expect(templates.length).toBeGreaterThanOrEqual(12);
    expect(templates[0]).toHaveProperty("id");
    expect(templates[0]).toHaveProperty("name");
    expect(templates[0]).toHaveProperty("description");
    expect(templates[0]).toHaveProperty("category");
    expect(templates[0]).not.toHaveProperty("files");

    client.close();
  });

  it("apply_template scaffolds files and returns template_applied", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "apply_template", templateId: "react-vite-ts" });
    const msg = await client.receive();

    expect(msg.type).toBe("template_applied");
    expect((msg as any).templateId).toBe("react-vite-ts");
    expect((msg as any).name).toBe("React + Vite");

    // Verify files were written to the workspace
    expect(fs.existsSync(path.join(tmpDir, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "src/App.tsx"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "index.html"))).toBe(true);

    // Verify git committed the files
    const log = await gitManager.log();
    const templateCommit = log.find((c) => c.message.includes("Apply template"));
    expect(templateCommit).toBeDefined();

    client.close();
  });

  it("apply_template returns error for unknown template ID", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "apply_template", templateId: "does-not-exist" });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toContain("Unknown template");

    client.close();
  });

  it("apply_template returns error for empty template ID", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "apply_template", templateId: "" } as any);
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toContain("Template ID is required");

    client.close();
  });

  it("apply_template works for static-html template (no package.json)", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "apply_template", templateId: "static-html" });
    const msg = await client.receive();

    expect(msg.type).toBe("template_applied");
    expect((msg as any).templateId).toBe("static-html");

    expect(fs.existsSync(path.join(tmpDir, "index.html"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "style.css"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "main.js"))).toBe(true);
    // static-html has no package.json
    expect(fs.existsSync(path.join(tmpDir, "package.json"))).toBe(false);

    client.close();
  });

  it("apply_template works for nextjs template with nested directories", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "apply_template", templateId: "nextjs" });
    const msg = await client.receive();

    expect(msg.type).toBe("template_applied");
    expect(fs.existsSync(path.join(tmpDir, "src/app/layout.tsx"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "src/app/page.tsx"))).toBe(true);

    client.close();
  });
});

// ---------------------------------------------------------------------------
// GitHub authentication tests
// ---------------------------------------------------------------------------

describe("Integration: GitHub authentication", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let gitManager: GitManager;
  let sessionManager: SessionManager;
  let lastClaude: FakeClaudeProcess;
  let githubAuthManager: StubGitHubAuthManager;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-github-"));

    gitManager = new GitManager(tmpDir);
    await gitManager.init();

    const sessionsFile = path.join(tmpDir, "sessions.json");
    sessionManager = new SessionManager(sessionsFile);

    githubAuthManager = new StubGitHubAuthManager();

    app = await buildApp({
      gitManager,
      sessionManager,
      viteManager: new StubViteManager() as unknown as ViteManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: githubAuthManager as unknown as GitHubAuthManager,
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
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("github_get_status returns unauthenticated by default", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "github_get_status" });
    const msg = await client.receive();

    expect(msg.type).toBe("github_status");
    expect((msg as any).authenticated).toBe(false);

    client.close();
  });

  it("github_set_token with valid token returns authenticated status", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "github_set_token", token: "ghp_valid_test_token" });
    const msg = await client.receive();

    expect(msg.type).toBe("github_status");
    expect((msg as any).authenticated).toBe(true);
    expect((msg as any).username).toBe("test-user");

    client.close();
  });

  it("github_set_token with empty token returns error", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "github_set_token", token: "" });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("GitHub token cannot be empty");

    client.close();
  });

  it("github_set_token with whitespace-only token returns error", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "github_set_token", token: "   " });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("GitHub token cannot be empty");

    client.close();
  });

  it("github_logout clears credentials", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // First authenticate
    client.send({ type: "github_set_token", token: "ghp_test" });
    const authMsg = await client.receive();
    expect((authMsg as any).authenticated).toBe(true);

    // Then logout
    client.send({ type: "github_logout" });
    const logoutMsg = await client.receive();

    expect(logoutMsg.type).toBe("github_status");
    expect((logoutMsg as any).authenticated).toBe(false);

    client.close();
  });

  it("github_push without auth returns error", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "github_push" });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("Not authenticated with GitHub");

    client.close();
  });

  it("github_pull without auth returns error", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "github_pull" });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("Not authenticated with GitHub");

    client.close();
  });

  it("github_set_remote adds a remote and returns remotes list", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "github_set_remote", name: "origin", url: "https://github.com/test/repo.git" });
    const msg = await client.receive();

    expect(msg.type).toBe("github_remotes");
    expect((msg as any).remotes).toHaveLength(1);
    expect((msg as any).remotes[0]).toMatchObject({
      name: "origin",
      url: "https://github.com/test/repo.git",
    });

    client.close();
  });

  it("github_set_remote rejects empty name", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "github_set_remote", name: "", url: "https://github.com/test/repo.git" });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("Remote name and URL are required");

    client.close();
  });

  it("github_set_remote rejects empty url", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "github_set_remote", name: "origin", url: "" });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("Remote name and URL are required");

    client.close();
  });

  it("github_get_remotes returns empty list initially", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "github_get_remotes" });
    const msg = await client.receive();

    expect(msg.type).toBe("github_remotes");
    expect((msg as any).remotes).toEqual([]);

    client.close();
  });

  it("github_push with auth but no remote returns error", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Authenticate first
    client.send({ type: "github_set_token", token: "ghp_test" });
    await client.receive(); // github_status

    // Try to push without a remote configured
    client.send({ type: "github_push" });
    const msg = await client.receive();

    expect(msg.type).toBe("github_push_result");
    expect((msg as any).success).toBe(false);
    expect((msg as any).message).toContain("Push failed");

    client.close();
  });

  it("github_create_repo creates a repo and auto-configures remote", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Authenticate first
    client.send({ type: "github_set_token", token: "ghp_test" });
    await client.receive(); // github_status

    client.send({ type: "github_create_repo", name: "my-project", description: "A test project", isPrivate: true });
    const msg = await client.receive();

    expect(msg.type).toBe("github_repo_created");
    expect((msg as any).success).toBe(true);
    expect((msg as any).name).toBe("my-project");
    expect((msg as any).fullName).toBe("test-user/my-project");
    expect((msg as any).url).toBe("https://github.com/test-user/my-project");

    client.close();
  });

  it("github_create_repo without auth returns error", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "github_create_repo", name: "my-project" });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("Not authenticated with GitHub");

    client.close();
  });

  it("github_create_repo with empty name returns error", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Authenticate first
    client.send({ type: "github_set_token", token: "ghp_test" });
    await client.receive(); // github_status

    client.send({ type: "github_create_repo", name: "" });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("Repository name is required");

    client.close();
  });

  it("github_create_repo with invalid characters returns error", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Authenticate first
    client.send({ type: "github_set_token", token: "ghp_test" });
    await client.receive(); // github_status

    client.send({ type: "github_create_repo", name: "my project!" });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("Repository name contains invalid characters");

    client.close();
  });
});

// ---------------------------------------------------------------------------
// Usage & cost tracking tests
// ---------------------------------------------------------------------------

describe("Integration: Usage & cost tracking", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let gitManager: GitManager;
  let lastClaude: FakeClaudeProcess;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-usage-integration-"));
    gitManager = new GitManager(tmpDir);
    await gitManager.init();

    app = await buildApp({
      gitManager,
      sessionManager: new SessionManager(path.join(tmpDir, "sessions.json")),
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
    // Wait for any pending async operations (git auto-commit) to complete
    await new Promise((r) => setTimeout(r, 200));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors — CI tmpdir will be cleared anyway
    }
  });

  it("get_usage_stats returns empty stats initially", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "get_usage_stats" } as any);
    const msg = await client.receive();

    expect(msg).toMatchObject({
      type: "usage_stats",
      stats: {
        sessions: [],
        totalCostUsd: 0,
        totalTurns: 0,
      },
    });

    client.close();
  });

  it("usage_update is sent after result event with total_cost_usd", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Start a Claude turn
    client.send({ type: "send_message", text: "hello" });
    await new Promise((r) => setTimeout(r, 50));

    // Simulate system init
    lastClaude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "usage-session-1",
    });

    // Drain events (claude_event for system init, session_started)
    await client.receiveSkipLogs();
    await client.receiveSkipLogs();

    // Simulate assistant text
    lastClaude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "Hi there" }] },
    });
    await client.receiveSkipLogs(); // claude_event for assistant

    // Simulate result with cost
    lastClaude.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "usage-session-1",
      total_cost_usd: 0.42,
      duration_ms: 3200,
    });

    // We should get the claude_event for result AND the usage_update
    const resultEvent = await client.receiveSkipLogs();
    expect(resultEvent.type).toBe("claude_event");

    const usageUpdate = await client.receiveSkipLogs();
    expect(usageUpdate).toMatchObject({
      type: "usage_update",
      sessionId: "usage-session-1",
      totalCostUsd: 0.42,
      totalDurationMs: 3200,
      turnCount: 1,
    });

    // Emit done to finish the turn
    lastClaude.emit("done", 0);

    client.close();
  });

  it("usage_update accumulates across multiple turns", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // --- Turn 1 ---
    client.send({ type: "send_message", text: "turn 1" });
    await new Promise((r) => setTimeout(r, 50));
    lastClaude.emit("event", { type: "system", subtype: "init", session_id: "accum-session" });
    await client.receiveSkipLogs(); // claude_event
    await client.receiveSkipLogs(); // session_started

    lastClaude.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "accum-session",
      total_cost_usd: 0.10,
      duration_ms: 1000,
    });
    await client.receiveSkipLogs(); // claude_event
    const update1 = await client.receiveSkipLogs();
    expect(update1).toMatchObject({
      type: "usage_update",
      turnCount: 1,
      totalCostUsd: 0.10,
    });
    lastClaude.emit("done", 0);

    // Wait for done handler
    await new Promise((r) => setTimeout(r, 100));

    // --- Turn 2 ---
    client.send({ type: "send_message", text: "turn 2", sessionId: "accum-session" });
    await new Promise((r) => setTimeout(r, 50));
    lastClaude.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "accum-session",
      total_cost_usd: 0.20,
      duration_ms: 2000,
    });

    // Find the usage_update among possible messages
    let update2: any = null;
    for (let i = 0; i < 10; i++) {
      const msg = await client.receive();
      if (msg.type === "usage_update") {
        update2 = msg;
        break;
      }
    }

    expect(update2).toBeDefined();
    expect(update2.type).toBe("usage_update");
    expect(update2.turnCount).toBe(2);
    expect(update2.totalCostUsd).toBeCloseTo(0.30);
    expect(update2.totalDurationMs).toBe(3000);

    lastClaude.emit("done", 0);
    client.close();
  });

  it("get_usage_stats returns recorded data", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Record some usage by running a turn
    client.send({ type: "send_message", text: "test" });
    await new Promise((r) => setTimeout(r, 50));
    lastClaude.emit("event", { type: "system", subtype: "init", session_id: "stats-session" });
    await client.receiveSkipLogs(); // claude_event
    await client.receiveSkipLogs(); // session_started

    lastClaude.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "stats-session",
      total_cost_usd: 0.55,
      duration_ms: 5000,
    });
    await client.receiveSkipLogs(); // claude_event
    await client.receiveSkipLogs(); // usage_update
    lastClaude.emit("done", 0);
    await new Promise((r) => setTimeout(r, 100));

    // Now request full stats
    client.send({ type: "get_usage_stats" } as any);

    let statsMsg: any = null;
    for (let i = 0; i < 10; i++) {
      const msg = await client.receive();
      if (msg.type === "usage_stats") {
        statsMsg = msg;
        break;
      }
    }

    expect(statsMsg).toBeDefined();
    expect(statsMsg.stats.totalCostUsd).toBeCloseTo(0.55);
    expect(statsMsg.stats.totalTurns).toBe(1);
    expect(statsMsg.stats.sessions).toHaveLength(1);
    expect(statsMsg.stats.sessions[0]).toMatchObject({
      sessionId: "stats-session",
      totalCostUsd: 0.55,
      totalDurationMs: 5000,
      turnCount: 1,
    });

    client.close();
  });

  it("no usage_update when total_cost_usd is undefined", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "hello" });
    await new Promise((r) => setTimeout(r, 50));
    lastClaude.emit("event", { type: "system", subtype: "init", session_id: "no-cost-session" });

    // Result without total_cost_usd
    lastClaude.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "no-cost-session",
    });

    lastClaude.emit("done", 0);
    await new Promise((r) => setTimeout(r, 200));

    // Drain all messages and check none are usage_update
    const allMessages: any[] = [];
    try {
      for (let i = 0; i < 20; i++) {
        allMessages.push(await client.receive(200));
      }
    } catch {
      // timeout is expected when no more messages
    }
    expect(allMessages.every((m: any) => m.type !== "usage_update")).toBe(true);

    client.close();
  });

  it("delete_session also deletes usage data", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Record some usage
    client.send({ type: "send_message", text: "test" });
    await new Promise((r) => setTimeout(r, 50));
    lastClaude.emit("event", { type: "system", subtype: "init", session_id: "del-usage-session" });
    await client.receiveSkipLogs(); // claude_event
    await client.receiveSkipLogs(); // session_started

    lastClaude.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "del-usage-session",
      total_cost_usd: 0.99,
      duration_ms: 7000,
    });
    await client.receiveSkipLogs(); // claude_event
    await client.receiveSkipLogs(); // usage_update
    lastClaude.emit("done", 0);
    await new Promise((r) => setTimeout(r, 100));

    // Delete the session
    client.send({ type: "delete_session", sessionId: "del-usage-session" });

    // Drain messages until we get session_list
    let sessionList: any = null;
    for (let i = 0; i < 10; i++) {
      const msg = await client.receive();
      if (msg.type === "session_list") {
        sessionList = msg;
        break;
      }
    }
    expect(sessionList).toBeDefined();

    // Verify usage is gone
    client.send({ type: "get_usage_stats" } as any);
    let statsMsg: any = null;
    for (let i = 0; i < 10; i++) {
      const msg = await client.receive();
      if (msg.type === "usage_stats") {
        statsMsg = msg;
        break;
      }
    }
    expect(statsMsg.stats.totalTurns).toBe(0);
    expect(statsMsg.stats.sessions).toHaveLength(0);

    client.close();
  });
});

// ---------------------------------------------------------------------------
// System prompt tests
// ---------------------------------------------------------------------------

describe("Integration: System prompt", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let gitManager: GitManager;
  let lastClaude: FakeClaudeProcess;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-sysprompt-"));
    gitManager = new GitManager(tmpDir);
    await gitManager.init();

    app = await buildApp({
      gitManager,
      sessionManager: new SessionManager(path.join(tmpDir, "sessions.json")),
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
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("get_system_prompt returns empty string when no file exists", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "get_system_prompt" } as any);
    const msg = await client.receive();

    expect(msg).toMatchObject({
      type: "system_prompt",
      content: "",
    });

    client.close();
  });

  it("set_system_prompt persists and confirms", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "set_system_prompt", content: "Always use TypeScript." } as any);
    const msg = await client.receive();

    expect(msg).toMatchObject({
      type: "system_prompt_saved",
      content: "Always use TypeScript.",
    });

    // Verify it was persisted to disk
    const filePath = path.join(tmpDir, ".shipit", "system-prompt.md");
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("Always use TypeScript.\n");

    client.close();
  });

  it("get_system_prompt returns saved content", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Set a prompt first
    client.send({ type: "set_system_prompt", content: "Use Tailwind CSS." } as any);
    await client.receive(); // system_prompt_saved

    // Now retrieve it
    client.send({ type: "get_system_prompt" } as any);
    const msg = await client.receive();

    expect(msg).toMatchObject({
      type: "system_prompt",
      content: "Use Tailwind CSS.",
    });

    client.close();
  });

  it("set_system_prompt with empty string deletes the file", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // First create a prompt
    client.send({ type: "set_system_prompt", content: "Something" } as any);
    await client.receive(); // system_prompt_saved

    // Now clear it
    client.send({ type: "set_system_prompt", content: "" } as any);
    const msg = await client.receive();

    expect(msg).toMatchObject({
      type: "system_prompt_saved",
      content: "",
    });

    // File should be deleted
    const filePath = path.join(tmpDir, ".shipit", "system-prompt.md");
    expect(fs.existsSync(filePath)).toBe(false);

    client.close();
  });

  it("set_system_prompt with whitespace-only string deletes the file", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // First create a prompt
    client.send({ type: "set_system_prompt", content: "Something" } as any);
    await client.receive(); // system_prompt_saved

    // Now send whitespace-only
    client.send({ type: "set_system_prompt", content: "   \n  \t  " } as any);
    const msg = await client.receive();

    expect(msg).toMatchObject({
      type: "system_prompt_saved",
      content: "",
    });

    client.close();
  });

  it("set_system_prompt trims whitespace", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "set_system_prompt", content: "  Use strict mode.  \n" } as any);
    const msg = await client.receive();

    expect(msg).toMatchObject({
      type: "system_prompt_saved",
      content: "Use strict mode.",
    });

    client.close();
  });

  it("set_system_prompt rejects content over 50KB", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    const hugeContent = "x".repeat(50_001);
    client.send({ type: "set_system_prompt", content: hugeContent } as any);
    const msg = await client.receive();

    expect(msg).toMatchObject({
      type: "error",
      message: "System prompt too long (max 50,000 characters)",
    });

    client.close();
  });

  it("set_system_prompt rejects non-string content", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "set_system_prompt", content: 42 } as any);
    const msg = await client.receive();

    expect(msg).toMatchObject({
      type: "error",
      message: "System prompt must be a string",
    });

    client.close();
  });

  it("system prompt is passed to ClaudeProcess.run() when set", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Set a system prompt
    client.send({ type: "set_system_prompt", content: "Be concise." } as any);
    await client.receive(); // system_prompt_saved

    // Send a message to Claude
    client.send({ type: "send_message", text: "Hello" });
    await new Promise((r) => setTimeout(r, 50));

    expect(lastClaude.runCalled).toBe(true);
    expect(lastClaude.lastSystemPrompt).toBe("Be concise.");

    client.close();
  });

  it("system prompt is undefined when no file exists", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "Hello" });
    await new Promise((r) => setTimeout(r, 50));

    expect(lastClaude.runCalled).toBe(true);
    expect(lastClaude.lastSystemPrompt).toBeUndefined();

    client.close();
  });
});

// ---------------------------------------------------------------------------
// File watcher tests
// ---------------------------------------------------------------------------

describe("Integration: File watcher", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let gitManager: GitManager;
  let lastClaude: FakeClaudeProcess;
  let stubFileWatcher: StubFileWatcher;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-filewatcher-"));
    gitManager = new GitManager(tmpDir);
    await gitManager.init();

    stubFileWatcher = new StubFileWatcher();
    lastClaude = undefined as unknown as FakeClaudeProcess;

    app = await buildApp({
      gitManager,
      sessionManager: new SessionManager(path.join(tmpDir, "sessions.json")),
      chatHistoryManager: new ChatHistoryManager(path.join(tmpDir, "chat-history")),
      viteManager: new StubViteManager() as unknown as ViteManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      claudeFactory: () => {
        lastClaude = new FakeClaudeProcess();
        return lastClaude as unknown as ClaudeProcess;
      },
      fileWatcher: stubFileWatcher as unknown as FileWatcher,
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
    await new Promise((r) => setTimeout(r, 100));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("broadcasts files_changed when file watcher emits changes", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Simulate file changes via the stub
    stubFileWatcher.simulateChanges(["src/app.ts", "package.json"]);

    const msg = await client.receive();

    expect(msg).toMatchObject({
      type: "files_changed",
      paths: ["src/app.ts", "package.json"],
    });

    client.close();
  });

  it("broadcasts files_changed to multiple connected clients", async () => {
    const client1 = await TestClient.connect(port);
    await client1.receive(); // preview_status

    const client2 = await TestClient.connect(port);
    await client2.receive(); // preview_status

    stubFileWatcher.simulateChanges(["index.html"]);

    const msg1 = await client1.receive();
    const msg2 = await client2.receive();

    expect(msg1).toMatchObject({ type: "files_changed", paths: ["index.html"] });
    expect(msg2).toMatchObject({ type: "files_changed", paths: ["index.html"] });

    client1.close();
    client2.close();
  });

  it("handles multiple sequential file change events", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // First batch of changes
    stubFileWatcher.simulateChanges(["a.ts"]);
    const msg1 = await client.receive();
    expect(msg1).toMatchObject({ type: "files_changed", paths: ["a.ts"] });

    // Second batch of changes
    stubFileWatcher.simulateChanges(["b.ts", "c.ts"]);
    const msg2 = await client.receive();
    expect(msg2).toMatchObject({ type: "files_changed", paths: ["b.ts", "c.ts"] });

    client.close();
  });

  it("files_changed is not received after client disconnects", async () => {
    const client1 = await TestClient.connect(port);
    await client1.receive(); // preview_status

    const client2 = await TestClient.connect(port);
    await client2.receive(); // preview_status

    // Disconnect client1
    client1.close();
    await new Promise((r) => setTimeout(r, 100));

    // Simulate changes — only client2 should receive
    stubFileWatcher.simulateChanges(["test.ts"]);
    const msg = await client2.receive();
    expect(msg).toMatchObject({ type: "files_changed", paths: ["test.ts"] });

    client2.close();
  });

  // ---- Image upload (send_message with images) ----

  // A minimal 1x1 red PNG (valid base64)
  const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==";

  it("send_message with valid images passes them to ClaudeProcess", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({
      type: "send_message",
      text: "Make it look like this",
      images: [
        { data: TINY_PNG_BASE64, mediaType: "image/png", filename: "design.png" },
      ],
    });

    // Give the server time to process the message and start Claude
    await new Promise((r) => setTimeout(r, 100));

    // The FakeClaudeProcess should have been called with images
    expect(lastClaude.runCalled).toBe(true);
    expect(lastClaude.lastPrompt).toBe("Make it look like this");
    expect(lastClaude.lastImages).toHaveLength(1);
    expect(lastClaude.lastImages![0].mediaType).toBe("image/png");
    expect(lastClaude.lastImages![0].data).toBe(TINY_PNG_BASE64);

    // Simulate Claude finishing
    lastClaude.emit("event", { type: "system", subtype: "init", session_id: "img-session-1" });
    lastClaude.emit("done", 0);

    client.close();
  });

  it("send_message with invalid MIME type returns error", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({
      type: "send_message",
      text: "Upload PDF",
      images: [
        { data: TINY_PNG_BASE64, mediaType: "application/pdf", filename: "doc.pdf" },
      ],
    });

    const msg = await client.receive();
    expect(msg.type).toBe("error");
    expect((msg as any).message).toContain("unsupported type");

    client.close();
  });

  it("send_message with too many images returns error", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    const images = Array.from({ length: 6 }, (_, i) => ({
      data: TINY_PNG_BASE64,
      mediaType: "image/png",
      filename: `img${i}.png`,
    }));

    client.send({
      type: "send_message",
      text: "Too many",
      images,
    });

    const msg = await client.receive();
    expect(msg.type).toBe("error");
    expect((msg as any).message).toContain("Too many images");

    client.close();
  });

  it("send_message with oversized image returns error", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Create a base64 string that decodes to > 5MB
    // Each base64 char = 6 bits, so 4 chars = 3 bytes
    // 5MB = 5242880 bytes -> need ~7000000 base64 chars
    const bigData = Buffer.alloc(5 * 1024 * 1024 + 1, 0x41).toString("base64");

    client.send({
      type: "send_message",
      text: "Big image",
      images: [
        { data: bigData, mediaType: "image/png", filename: "huge.png" },
      ],
    });

    const msg = await client.receive();
    expect(msg.type).toBe("error");
    expect((msg as any).message).toContain("too large");

    client.close();
  });

  it("send_message with images persists them in chat history", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({
      type: "send_message",
      text: "Check this",
      images: [
        { data: TINY_PNG_BASE64, mediaType: "image/png", filename: "test.png" },
      ],
    });

    // Poll until claudeFactory has been called (deterministic, no fixed timeout)
    const deadline = Date.now() + 5000;
    while (!lastClaude?.runCalled) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for claudeFactory");
      await new Promise((r) => setTimeout(r, 10));
    }

    lastClaude.emit("event", { type: "system", subtype: "init", session_id: "img-persist-test" });
    lastClaude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "I see the image" }] },
    });
    lastClaude.emit("event", { type: "result", subtype: "success", session_id: "img-persist-test" });
    lastClaude.emit("done", 0);

    // Now load the chat history — chat persistence is synchronous so it's
    // already on disk by the time the emit() calls above return.
    client.send({ type: "get_chat_history", sessionId: "img-persist-test" });

    // Drain until we get chat_history
    let chatHistory: any = null;
    for (let i = 0; i < 20; i++) {
      const m = await client.receive();
      if (m.type === "chat_history") {
        chatHistory = m;
        break;
      }
    }

    expect(chatHistory).not.toBeNull();
    expect(chatHistory.messages.length).toBeGreaterThanOrEqual(2);
    // Find the first user message with images
    const userMsg = chatHistory.messages.find((m: any) => m.role === "user" && m.images?.length > 0);
    expect(userMsg).toBeDefined();
    expect(userMsg.text).toBe("Check this");
    expect(userMsg.images).toHaveLength(1);
    expect(userMsg.images[0].mediaType).toBe("image/png");

    client.close();
  });

  it("send_message with 0 images works normally (no validation error)", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({
      type: "send_message",
      text: "No images",
      images: [],
    });

    // Should start Claude normally without error
    await new Promise((r) => setTimeout(r, 50));
    expect(lastClaude.runCalled).toBe(true);
    expect(lastClaude.lastPrompt).toBe("No images");
    expect(lastClaude.lastImages).toBeUndefined();

    lastClaude.emit("done", 0);
    client.close();
  });
});

// ---------------------------------------------------------------------------
// Git identity flow
// ---------------------------------------------------------------------------

describe("Integration: git identity flow", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let origHome: string | undefined;
  let origNoSystem: string | undefined;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-gitid-"));
  });

  afterEach(async () => {
    // Restore process.env (in case test set it)
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    if (origNoSystem !== undefined) process.env.GIT_CONFIG_NOSYSTEM = origNoSystem;
    else delete process.env.GIT_CONFIG_NOSYSTEM;

    if (app) await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Create a git repo in tmpDir with NO identity configured.
   * Also overrides process.env so simple-git child processes ignore global config.
   */
  async function initRepoWithoutIdentity(): Promise<GitManager> {
    origHome = process.env.HOME;
    origNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
    process.env.HOME = tmpDir;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    const { execSync } = await import("node:child_process");
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: tmpDir };
    execSync("git init", { cwd: tmpDir, env });
    execSync("git config commit.gpgsign false", { cwd: tmpDir, env });
    // Set temporary identity, commit, then unset so the repo has no persistent identity
    execSync("git config user.name tmp", { cwd: tmpDir, env });
    execSync("git config user.email tmp@tmp", { cwd: tmpDir, env });
    execSync('git commit --allow-empty -m "init"', { cwd: tmpDir, env });
    execSync("git config --unset user.name", { cwd: tmpDir, env });
    execSync("git config --unset user.email", { cwd: tmpDir, env });
    return new GitManager(tmpDir);
  }

  async function startApp(gitManager: GitManager): Promise<number> {
    const sessionsFile = path.join(tmpDir, "sessions.json");
    app = await buildApp({
      gitManager,
      sessionManager: new SessionManager(sessionsFile),
      viteManager: new StubViteManager() as unknown as ViteManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      claudeFactory: () => new FakeClaudeProcess() as unknown as ClaudeProcess,
      fileWatcher: new StubFileWatcher() as unknown as FileWatcher,
      workspaceDir: tmpDir,
      serveStatic: false,
      startVite: false,
      portScanIntervalMs: 0,
    });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const match = address.match(/:(\d+)$/);
    return match ? Number(match[1]) : 0;
  }

  it("sends git_identity_required on connect when identity is missing", async () => {
    const gitManager = await initRepoWithoutIdentity();
    port = await startApp(gitManager);

    const client = await TestClient.connect(port);
    const msg1 = await client.receive(); // preview_status
    expect(msg1.type).toBe("preview_status");

    const msg2 = await client.receive(); // git_identity_required
    expect(msg2.type).toBe("git_identity_required");

    client.close();
  });

  it("does not send git_identity_required when identity exists", async () => {
    const gitManager = new GitManager(tmpDir);
    await gitManager.init(); // init() sets identity
    port = await startApp(gitManager);

    const client = await TestClient.connect(port);
    const msg1 = await client.receive(); // preview_status
    expect(msg1.type).toBe("preview_status");

    // Should not receive git_identity_required — wait briefly to confirm
    await expect(client.receive(500)).rejects.toThrow("timed out");

    client.close();
  });

  it("sets git identity and responds with git_identity_set", async () => {
    const gitManager = await initRepoWithoutIdentity();
    port = await startApp(gitManager);

    const client = await TestClient.connect(port);
    await client.receive(); // preview_status
    await client.receive(); // git_identity_required

    client.send({ type: "set_git_identity", name: "Test User", email: "test@example.com" });
    const resp = await client.receive();
    expect(resp).toMatchObject({
      type: "git_identity_set",
      name: "Test User",
      email: "test@example.com",
    });

    // Verify identity is actually configured
    expect(await gitManager.hasIdentity()).toBe(true);

    client.close();
  });

  it("returns error for empty name", async () => {
    const gitManager = await initRepoWithoutIdentity();
    port = await startApp(gitManager);

    const client = await TestClient.connect(port);
    await client.receive(); // preview_status
    await client.receive(); // git_identity_required

    client.send({ type: "set_git_identity", name: "", email: "test@example.com" });
    const resp = await client.receive();
    expect(resp).toMatchObject({ type: "error", message: "Git user name cannot be empty" });

    client.close();
  });

  it("returns error for empty email", async () => {
    const gitManager = await initRepoWithoutIdentity();
    port = await startApp(gitManager);

    const client = await TestClient.connect(port);
    await client.receive(); // preview_status
    await client.receive(); // git_identity_required

    client.send({ type: "set_git_identity", name: "Test", email: "" });
    const resp = await client.receive();
    expect(resp).toMatchObject({ type: "error", message: "Git email cannot be empty" });

    client.close();
  });

  it("returns error for whitespace-only name", async () => {
    const gitManager = await initRepoWithoutIdentity();
    port = await startApp(gitManager);

    const client = await TestClient.connect(port);
    await client.receive(); // preview_status
    await client.receive(); // git_identity_required

    client.send({ type: "set_git_identity", name: "   ", email: "test@example.com" });
    const resp = await client.receive();
    expect(resp).toMatchObject({ type: "error", message: "Git user name cannot be empty" });

    client.close();
  });
});
