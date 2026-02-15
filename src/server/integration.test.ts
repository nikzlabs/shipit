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
import { AuthManager } from "./auth.js";
import { ViteManager } from "./vite-manager.js";
import { ClaudeProcess } from "./claude.js";
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
 * Fake ClaudeProcess for testing the send_message flow.
 * The test controls this object: call emit("event", ...) or emit("done", ...)
 * to simulate the real CLI producing output.
 */
class FakeClaudeProcess extends EventEmitter {
  public runCalled = false;
  public lastPrompt = "";
  public lastSessionId: string | undefined;
  public killed = false;

  run(prompt: string, sessionId?: string) {
    this.runCalled = true;
    this.lastPrompt = prompt;
    this.lastSessionId = sessionId;
  }

  kill() {
    this.killed = true;
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
      claudeFactory: () => {
        lastClaude = new FakeClaudeProcess();
        return lastClaude as unknown as ClaudeProcess;
      },
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
    client1.send({ type: "clear_logs" } as any);
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
