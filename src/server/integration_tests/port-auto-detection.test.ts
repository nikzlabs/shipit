import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../auth.js";
import { PreviewManager } from "../preview-manager.js";
import { ClaudeProcess } from "../claude.js";
import { FileWatcher } from "../file-watcher.js";
import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubPreviewManager,
  StubAuthManager,
  FakeClaudeProcess,
  StubFileWatcher,
  waitForClaude,
} from "./test-helpers.js";

describe("Integration: Port auto-detection", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let lastClaude: FakeClaudeProcess = null as any;
  /** Value returned by the injected detectPorts stub. */
  let stubDetectedPorts: number[];

  beforeEach(async () => {
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-portdetect-"));

    const sessionsFile = path.join(tmpDir, "sessions.json");
    sessionManager = new SessionManager(sessionsFile);

    stubDetectedPorts = [];

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      previewManager: new StubPreviewManager() as unknown as PreviewManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      claudeFactory: () => {
        lastClaude = new FakeClaudeProcess();
        return lastClaude as unknown as ClaudeProcess;
      },
      detectPorts: async () => stubDetectedPorts,
      fileWatcher: new StubFileWatcher() as unknown as FileWatcher,
      workspaceDir: tmpDir,
      serveStatic: false,
      startPreview: false,
      portScanIntervalMs: 0, // disable periodic scanning for these tests
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const match = address.match(/:(\d+)$/);
    port = match ? Number(match[1]) : 0;
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
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
    await waitForClaude(() => lastClaude);

    // Simulate Claude finishing
    lastClaude.finish();

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
    await waitForClaude(() => lastClaude);

    lastClaude.finish();

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
    await waitForClaude(() => lastClaude);
    lastClaude.finish();

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
    const prevClaude = lastClaude;
    client.send({ type: "send_message", text: "Change server" });
    await waitForClaude(() => lastClaude, prevClaude);
    lastClaude.finish();

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
    await waitForClaude(() => lastClaude);
    lastClaude.finish();

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
    await waitForClaude(() => lastClaude);
    lastClaude.finish();

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
