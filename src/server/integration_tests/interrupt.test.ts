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

describe("Integration: Interrupt and Redirect", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let lastClaude: FakeClaudeProcess;

  beforeEach(async () => {
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-interrupt-"));

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
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("sends claude_interrupted when interrupting an active process", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Start a Claude process
    client.send({ type: "send_message", text: "do something" });
    await waitForClaude(() => lastClaude);

    // Send interrupt
    client.send({ type: "interrupt_claude" });

    // Should receive claude_interrupted (skip any log entries)
    const interrupted = await client.receiveSkipLogs();
    expect(interrupted).toMatchObject({ type: "claude_interrupted" });

    // The FakeClaudeProcess should have been interrupted
    expect(lastClaude.interrupted).toBe(true);

    client.close();
  });

  it("returns error when interrupting with no active process", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Send interrupt with no active process
    client.send({ type: "interrupt_claude" });

    const response = await client.receiveSkipLogs();
    expect(response).toMatchObject({
      type: "error",
      message: "No active Claude process to interrupt",
    });

    client.close();
  });

  it("does not send spurious error after interrupt", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Start a Claude process
    client.send({ type: "send_message", text: "test" });
    await waitForClaude(() => lastClaude);

    // Send interrupt — this triggers claude_interrupted immediately,
    // and FakeClaudeProcess.interrupt() emits "done" with code 1 after 10ms.
    client.send({ type: "interrupt_claude" });

    const interrupted = await client.receiveSkipLogs();
    expect(interrupted).toMatchObject({ type: "claude_interrupted" });

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
    const queued = await client.receiveSkipLogs();
    expect(queued).toMatchObject({ type: "message_queued", text: "queued message" });

    // Interrupt — should clear the queue
    client.send({ type: "interrupt_claude" });

    const interrupted = await client.receiveSkipLogs();
    expect(interrupted).toMatchObject({ type: "claude_interrupted" });

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

  it("allows sending a new message after interrupt (redirect)", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Start a Claude process
    client.send({ type: "send_message", text: "wrong approach" });
    const firstClaude = await waitForClaude(() => lastClaude);

    // Interrupt
    client.send({ type: "interrupt_claude" });
    const interrupted = await client.receiveSkipLogs();
    expect(interrupted).toMatchObject({ type: "claude_interrupted" });

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
