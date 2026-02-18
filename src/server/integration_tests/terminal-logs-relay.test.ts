import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../auth.js";
import { ViteManager } from "../vite-manager.js";
import { ClaudeProcess } from "../claude.js";
import { FileWatcher } from "../file-watcher.js";
import type { WsServerMessage } from "../types.js";
import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubViteManager,
  StubAuthManager,
  FakeClaudeProcess,
  StubFileWatcher,
  waitForClaude,
} from "./test-helpers.js";

describe("Integration: Terminal/logs relay", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let lastClaude: FakeClaudeProcess = null as any;

  beforeEach(async () => {
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-logs-"));

    const sessionsFile = path.join(tmpDir, "sessions.json");
    sessionManager = new SessionManager(sessionsFile);

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
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
    await waitForClaude(() => lastClaude);

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
    await waitForClaude(() => lastClaude);

    // Should receive "Claude process started" log
    const startLog = await client.receive();
    expect(startLog.type).toBe("log_entry");
    expect((startLog as any).source).toBe("server");
    expect((startLog as any).text).toBe("Claude process started");

    // Simulate Claude finishing
    lastClaude.finish();

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

  it("sends buffered logs to newly connected clients", async () => {
    // First client triggers some log entries
    const client1 = await TestClient.connect(port);
    await client1.receive(); // preview_status

    client1.send({ type: "send_message", text: "generate logs" });
    await waitForClaude(() => lastClaude);

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
    await waitForClaude(() => lastClaude);
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

  // ---- Preview error relay ----

  it("relays preview_error to terminal log buffer", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({
      type: "preview_error",
      message: "TypeError: Cannot read properties of undefined",
      stack: "TypeError: Cannot read properties of undefined\n  at App.tsx:42",
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
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "preview_error", message: "   " });

    const resp = await client.receive();
    expect(resp).toMatchObject({ type: "error", message: "Preview error message cannot be empty" });

    client.close();
  });

  it("rejects overly long preview_error messages", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "preview_error", message: "x".repeat(11_000) });

    const resp = await client.receive();
    expect(resp).toMatchObject({ type: "error", message: "Preview error message too long (max 10,000 characters)" });

    client.close();
  });

  it("preview log entries are included in buffer for new clients", async () => {
    const client1 = await TestClient.connect(port);
    await client1.receive(); // preview_status

    // Send a preview error to populate the log buffer
    client1.send({
      type: "preview_error",
      message: "Runtime error in preview",
    });
    await client1.receive(); // log_entry

    // Second client should get buffered preview log entries
    const client2 = await TestClient.connect(port);
    await client2.receive(); // preview_status

    // Collect messages and check for the preview log
    const messages: WsServerMessage[] = [];
    try {
      for (let i = 0; i < 5; i++) {
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
