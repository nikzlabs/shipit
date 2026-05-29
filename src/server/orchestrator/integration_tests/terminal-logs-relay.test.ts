import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../agents/claude/auth-manager.js";


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

describe("Integration: Terminal/logs relay", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let lastClaude: FakeClaudeProcess = null as any;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-logs-"));

    sessionManager = new SessionManager(dbManager);

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
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
    // Small delay to let lingering git processes release file handles
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors — temp dir will be cleaned by OS
    }
  });

  it("relays Claude stderr as log_entry to client", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "test" });
    await waitForClaude(() => lastClaude);
    lastClaude.initSession();

    // Consume the server "Agent process started" log entry
    const startLog = await client.receiveType("log_entry");
    expect(startLog.type).toBe("log_entry");
    expect((startLog as any).source).toBe("server");

    // Simulate stderr from Claude CLI
    lastClaude.emit("log", "stderr", "Debug: loading model");

    const msg = await client.receiveType("log_entry");
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
    await waitForClaude(() => lastClaude);
    lastClaude.initSession();

    // Consume "Agent process started" log entry
    await client.receiveType("log_entry");

    // Simulate non-JSON stdout from Claude CLI
    lastClaude.emit("log", "stdout", "Warning: experimental feature");

    const msg = await client.receiveType("log_entry");
    expect(msg.type).toBe("log_entry");
    expect((msg as any).source).toBe("stdout");
    expect((msg as any).text).toBe("Warning: experimental feature");

    client.close();
  });

  it("sends server lifecycle log entries (process start/exit)", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "test" });
    await waitForClaude(() => lastClaude);
    lastClaude.initSession();

    // Should receive "Agent process started" log
    const startLog = await client.receiveType("log_entry");
    expect(startLog.type).toBe("log_entry");
    expect((startLog as any).source).toBe("server");
    expect((startLog as any).text).toBe("Agent process started");

    // Simulate Claude finishing
    lastClaude.finish();

    // Should receive "Agent process exited" log
    // (may also receive git_committed or other messages — drain until we find the exit log)
    let exitLog: any = null;
    for (let i = 0; i < 15; i++) {
      const msg = await client.receive();
      if (msg.type === "log_entry" && (msg as any).text.includes("exited")) {
        exitLog = msg;
        break;
      }
    }

    expect(exitLog).not.toBeNull();
    expect(exitLog.source).toBe("server");
    expect(exitLog.text).toBe("Agent process exited with code 0");

    // Drain remaining messages (e.g. git_committed) so the async done handler
    // (autoCommit, portScan) finishes before afterEach tears down the temp dir.
    try {
      for (let i = 0; i < 5; i++) {
        await client.receive(300);
      }
    } catch {
      // timeout expected when no more messages
    }

    client.close();
  });

  it("sends buffered logs to newly connected clients on the SAME session", async () => {
    // First client triggers some log entries
    const client1 = await TestClient.connect(port);
    await client1.receive(); // preview_status

    client1.send({ type: "send_message", text: "generate logs" });
    await waitForClaude(() => lastClaude);
    lastClaude.initSession();

    // Consume the "Agent process started" log
    await client1.receiveType("log_entry");

    // Add more logs via CLI output
    lastClaude.emit("log", "stderr", "Loading model...");
    await client1.receiveType("log_entry"); // consume the stderr log

    // Second client connects to the same session — should receive buffered logs
    // (turn event buffer entries may arrive before preview_status)
    const client2 = await TestClient.connect(port, client1.sessionId);

    // Collect all initial messages
    const allMsgs: WsServerMessage[] = [];
    try {
      for (let i = 0; i < 15; i++) {
        allMsgs.push(await client2.receive(500));
      }
    } catch { /* timeout expected */ }

    const logEntries = allMsgs.filter((m) => m.type === "log_entry");
    expect(logEntries.find((m) => (m as any).text === "Agent process started")).toBeDefined();
    expect(logEntries.find((m) => (m as any).text === "Loading model...")).toBeDefined();

    client1.close();
    client2.close();
  });

  it("does NOT leak buffered logs across sessions", async () => {
    // Session A generates logs
    const clientA = await TestClient.connect(port);
    await clientA.receive(); // preview_status

    clientA.send({ type: "send_message", text: "session A work" });
    await waitForClaude(() => lastClaude);
    lastClaude.initSession();

    await clientA.receiveType("log_entry"); // "Agent process started"
    lastClaude.emit("log", "stderr", "Session A debug output");
    await clientA.receiveType("log_entry"); // consume

    // Brand-new client connects to a DIFFERENT (newly-created) session.
    // It must not receive any of Session A's log entries.
    const clientB = await TestClient.connect(port);
    expect(clientB.sessionId).not.toBe(clientA.sessionId);

    const initialMsgs: WsServerMessage[] = [];
    try {
      for (let i = 0; i < 6; i++) {
        initialMsgs.push(await clientB.receive(300));
      }
    } catch { /* timeout expected */ }

    const leakedLogs = initialMsgs.filter(
      (m) => m.type === "log_entry" &&
        ((m as any).text === "Agent process started" ||
          (m as any).text === "Session A debug output"),
    );
    expect(leakedLogs).toHaveLength(0);

    clientA.close();
    clientB.close();
  });

  it("clear_logs empties the log buffer for the current session", async () => {
    // Generate some logs
    const client1 = await TestClient.connect(port);
    await client1.receive(); // preview_status

    client1.send({ type: "send_message", text: "test" });
    await waitForClaude(() => lastClaude);
    lastClaude.initSession();
    await client1.receiveType("log_entry"); // "Agent process started" log

    // Clear logs
    client1.send({ type: "clear_logs" });
    await new Promise((r) => setTimeout(r, 50));

    // New client connecting to the SAME session should not receive any
    // buffered logs (the buffer for this session is empty after clear_logs).
    const client2 = await TestClient.connect(port, client1.sessionId);

    // Wait a bit — should not receive any log entries
    let gotLog = false;
    try {
      for (let i = 0; i < 5; i++) {
        const msg = await client2.receive(200);
        if (msg.type === "log_entry") {
          gotLog = true;
          break;
        }
      }
    } catch {
      // Timeout — expected, no logs to receive
    }
    expect(gotLog).toBe(false);

    client1.close();
    client2.close();
  });

  // ---- Preview error relay ----

  it("relays preview_error to terminal log buffer", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Send preview error via HTTP using the client's actual session ID
    await app.inject({
      method: "POST",
      url: `/api/sessions/${client.sessionId}/preview-errors`,
      payload: {
        message: "TypeError: Cannot read properties of undefined",
        stack: "TypeError: Cannot read properties of undefined\n  at App.tsx:42",
      },
    });

    const logEntry = await client.receive();
    expect(logEntry).toMatchObject({
      type: "log_entry",
      source: "preview",
      text: expect.stringContaining("TypeError: Cannot read properties of undefined"),
    });
    // Stack should also be included in the text
    expect((logEntry as any).text).toContain("App.tsx:42");

    client.close();
  });

  it("rejects empty preview_error messages", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/any/preview-errors",
      payload: { message: "   " },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Preview error message cannot be empty");
  });

  it("rejects overly long preview_error messages", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/any/preview-errors",
      payload: { message: "x".repeat(11_000) },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Preview error message too long (max 10,000 characters)");
  });

  it("preview log entries are included in buffer for new clients", async () => {
    const client1 = await TestClient.connect(port);
    await client1.receive(); // preview_status

    // Send a preview error via HTTP using the client's actual session ID
    await app.inject({
      method: "POST",
      url: `/api/sessions/${client1.sessionId}/preview-errors`,
      payload: { message: "Runtime error in preview" },
    });
    await client1.receive(); // log_entry

    // Second client connects to the same session — should get buffered preview log entries
    const client2 = await TestClient.connect(port, client1.sessionId);

    // Collect all messages (preview_status, log buffer, etc.) and search for the preview log
    const messages: WsServerMessage[] = [];
    try {
      for (let i = 0; i < 10; i++) {
        messages.push(await client2.receive(500));
      }
    } catch {
      // Timeout — we've collected what's available
    }
    const previewLog = messages.find((m) => m.type === "log_entry" && (m as any).source === "preview");
    expect(previewLog).toBeDefined();
    expect((previewLog as any).text).toContain("Runtime error in preview");

    client1.close();
    client2.close();
  });
});
