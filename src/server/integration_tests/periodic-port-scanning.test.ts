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
import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubViteManager,
  StubAuthManager,
  FakeClaudeProcess,
  StubFileWatcher,
  waitForClaude,
} from "./test-helpers.js";

describe("Integration: Periodic port scanning", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let gitManager: GitManager;
  let sessionManager: SessionManager;
  let lastClaude: FakeClaudeProcess = null as any;
  /** Value returned by the injected detectPorts stub. */
  let stubDetectedPorts: number[];
  /** Count how many times detectPorts was called. */
  let detectPortsCallCount: number;

  beforeEach(async () => {
    lastClaude = null as any;
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
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("detects a port started mid-turn without waiting for Claude to finish", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // initial preview_status (not running)

    // Start a Claude message flow (Claude is still running)
    client.send({ type: "send_message", text: "Start a server" });
    await waitForClaude(() => lastClaude);

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
