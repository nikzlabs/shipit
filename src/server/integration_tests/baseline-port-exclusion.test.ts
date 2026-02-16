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

describe("Integration: Baseline port exclusion", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let gitManager: GitManager;
  let sessionManager: SessionManager;
  let lastClaude: FakeClaudeProcess = null as any;
  /** Exclude lists received by the detectPorts stub across all calls. */
  let capturedExcludeLists: number[][];

  beforeEach(async () => {
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-baseline-"));

    gitManager = new GitManager(tmpDir);
    await gitManager.init();

    const sessionsFile = path.join(tmpDir, "sessions.json");
    sessionManager = new SessionManager(sessionsFile);

    capturedExcludeLists = [];

    app = await buildApp({
      gitManager,
      sessionManager,
      viteManager: new StubViteManager() as unknown as ViteManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      claudeFactory: () => {
        lastClaude = new FakeClaudeProcess();
        return lastClaude as unknown as ClaudeProcess;
      },
      // Capture the exclude list that runPortScan passes to detectPorts
      detectPorts: async (excludePorts: number[]) => {
        capturedExcludeLists.push([...excludePorts]);
        return [];
      },
      fileWatcher: new StubFileWatcher() as unknown as FileWatcher,
      workspaceDir: tmpDir,
      serveStatic: false,
      startVite: false,
      portScanIntervalMs: 0,
      // Simulate ports 8080 and 5174 already open before the session started
      // (e.g. ShipIt's own dev Vite server, or other host tooling).
      baselinePorts: [8080, 5174],
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const match = address.match(/:(\d+)$/);
    port = match ? Number(match[1]) : 0;
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("passes baseline ports in the exclude list to detectPorts", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // initial preview_status

    // Trigger a port scan via a Claude turn
    client.send({ type: "send_message", text: "hello" });
    await waitForClaude(() => lastClaude);
    lastClaude.emit("done", 0);

    // Wait for the scan to run (needs extra time under parallel test load)
    await new Promise((r) => setTimeout(r, 500));

    expect(capturedExcludeLists.length).toBeGreaterThanOrEqual(1);
    const lastExclude = capturedExcludeLists[capturedExcludeLists.length - 1]!;
    // Should contain both baseline ports alongside the server/vite ports
    expect(lastExclude).toContain(8080);
    expect(lastExclude).toContain(5174);

    client.close();
  });
});
