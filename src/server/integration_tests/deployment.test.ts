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
import { DeploymentManager } from "../deployment-manager.js";
import { DeploymentStore } from "../deployment-store.js";
import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubPreviewManager,
  StubAuthManager,
  FakeClaudeProcess,
  StubFileWatcher,
  StubDeploymentManager,
  StubDeploymentStore,
} from "./test-helpers.js";

describe("Integration: Deployment", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let testSessionId: string;
  let stubDeployMgr: StubDeploymentManager;
  let stubDeployStore: StubDeploymentStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-deploy-"));

    const sessionsFile = path.join(tmpDir, "sessions.json");
    sessionManager = new SessionManager(sessionsFile);

    // Pre-create a tracked session for HTTP endpoint tests
    testSessionId = "deploy-test-session";
    const testSessionDir = path.join(tmpDir, "sessions", testSessionId);
    fs.mkdirSync(testSessionDir, { recursive: true });
    sessionManager.track(testSessionId, "Test session", testSessionDir);

    stubDeployMgr = new StubDeploymentManager();
    stubDeployMgr.register({
      info: {
        id: "test-target",
        name: "Test Deploy",
        description: "Test target",
        configFields: [{ key: "token", label: "Token", required: true, sensitive: true }],
        supportsPreview: true,
      },
    });

    stubDeployStore = new StubDeploymentStore();

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      previewManager: new StubPreviewManager() as unknown as PreviewManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      claudeFactory: () => new FakeClaudeProcess() as unknown as ClaudeProcess,
      fileWatcher: new StubFileWatcher() as unknown as FileWatcher,
      deploymentManager: stubDeployMgr as unknown as DeploymentManager,
      deploymentStore: stubDeployStore as unknown as DeploymentStore,
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
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("lists deploy targets", async () => {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${testSessionId}/deploy/setup` });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.targets).toHaveLength(1);
    expect(data.targets[0].id).toBe("test-target");
  });

  it("returns deploy config status", async () => {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${testSessionId}/deploy/setup` });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.projectSettings).toHaveProperty("test-target");
    expect(data.projectSettings["test-target"].configured).toBe(false);
  });

  it("returns empty deploy history for new session", async () => {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${testSessionId}/deploy/history` });
    expect(res.statusCode).toBe(200);
    expect(res.json().deployments).toEqual([]);
  });

  it("rejects initiate_deploy without active session", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "initiate_deploy", targetId: "test-target" } as any);
    const msg = await client.receiveSkipLogs();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toMatch(/No active session/);

    client.close();
  });

  it("cancel_deploy does not throw without active deployment", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "cancel_deploy" } as any);
    // No error should be sent; cancel is silently a no-op
    // Wait a bit to ensure no error arrives
    const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 200));
    const msg = Promise.race([client.receiveSkipLogs(300).catch(() => "timeout"), timeout]);
    const result = await msg;
    expect(result).toBe("timeout");

    client.close();
  });
});
