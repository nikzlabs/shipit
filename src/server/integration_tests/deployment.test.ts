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
import { DeploymentManager } from "../deployment-manager.js";
import { DeploymentStore } from "../deployment-store.js";
import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubViteManager,
  StubAuthManager,
  FakeClaudeProcess,
  StubFileWatcher,
  StubDeploymentManager,
  StubDeploymentStore,
  waitForClaude,
} from "./test-helpers.js";

describe("Integration: Deployment", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let stubDeployMgr: StubDeploymentManager;
  let stubDeployStore: StubDeploymentStore;
  let latestClaude: FakeClaudeProcess | null = null;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-deploy-"));
    latestClaude = null;

    const gitManager = new GitManager(tmpDir);
    await gitManager.init();

    const sessionsFile = path.join(tmpDir, "sessions.json");
    const sessionManager = new SessionManager(sessionsFile);

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
      gitManager,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      viteManager: new StubViteManager() as unknown as ViteManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      claudeFactory: () => {
        const p = new FakeClaudeProcess();
        latestClaude = p;
        return p as unknown as ClaudeProcess;
      },
      fileWatcher: new StubFileWatcher() as unknown as FileWatcher,
      deploymentManager: stubDeployMgr as unknown as DeploymentManager,
      deploymentStore: stubDeployStore as unknown as DeploymentStore,
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

  it("lists deploy targets", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "list_deploy_targets" } as any);
    const msg = await client.receiveSkipLogs();

    expect(msg.type).toBe("deploy_targets");
    expect((msg as any).targets).toHaveLength(1);
    expect((msg as any).targets[0].id).toBe("test-target");

    client.close();
  });

  it("rejects deploy_configure with invalid target", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({
      type: "deploy_configure",
      targetId: "nonexistent",
      credentials: {},
    } as any);
    const msg = await client.receiveSkipLogs();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toMatch(/Unknown deploy target/);

    client.close();
  });

  it("rejects deploy_configure without active session", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({
      type: "deploy_configure",
      targetId: "test-target",
      credentials: { token: "tok123" },
    } as any);
    const msg = await client.receiveSkipLogs();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toMatch(/No active session/);

    client.close();
  });

  it("saves deploy config for active session", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Start a session to get an active session
    client.send({ type: "send_message", text: "hello" });
    const claude = await waitForClaude(() => latestClaude);
    claude.emit("event", { type: "system", subtype: "init", session_id: "cs1" });
    claude.finish("cs1");

    // Drain session messages
    let msg;
    do {
      msg = await client.receiveSkipLogs();
    } while (msg.type !== "claude_event" || (msg as any).event?.type !== "result");

    // Configure deploy
    client.send({
      type: "deploy_configure",
      targetId: "test-target",
      credentials: { token: "my-token" },
      projectName: "test-proj",
    } as any);
    const configMsg = await client.receiveSkipLogs();

    expect(configMsg.type).toBe("deploy_config_saved");
    expect((configMsg as any).targetId).toBe("test-target");

    client.close();
  });

  it("rejects deploy_configure with empty required field", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Create a session
    client.send({ type: "send_message", text: "hi" });
    const claude = await waitForClaude(() => latestClaude);
    claude.emit("event", { type: "system", subtype: "init", session_id: "cs2" });
    claude.finish("cs2");

    // Drain messages
    let msg;
    do {
      msg = await client.receiveSkipLogs();
    } while (msg.type !== "claude_event" || (msg as any).event?.type !== "result");

    // Try to configure with empty token
    client.send({
      type: "deploy_configure",
      targetId: "test-target",
      credentials: { token: "" },
    } as any);
    const errMsg = await client.receiveSkipLogs();

    expect(errMsg.type).toBe("error");
    expect((errMsg as any).message).toMatch(/Token is required/);

    client.close();
  });

  it("returns deploy config status", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Create session
    client.send({ type: "send_message", text: "test" });
    const claude = await waitForClaude(() => latestClaude);
    claude.emit("event", { type: "system", subtype: "init", session_id: "cs3" });
    claude.finish("cs3");

    let msg;
    do {
      msg = await client.receiveSkipLogs();
    } while (msg.type !== "claude_event" || (msg as any).event?.type !== "result");

    client.send({ type: "get_deploy_config" } as any);
    const configMsg = await client.receiveSkipLogs();

    expect(configMsg.type).toBe("deploy_config");
    expect((configMsg as any).targets).toHaveProperty("test-target");
    expect((configMsg as any).targets["test-target"].configured).toBe(false);

    client.close();
  });

  it("returns empty deploy history for new session", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Create session
    client.send({ type: "send_message", text: "test" });
    const claude = await waitForClaude(() => latestClaude);
    claude.emit("event", { type: "system", subtype: "init", session_id: "cs4" });
    claude.finish("cs4");

    let msg;
    do {
      msg = await client.receiveSkipLogs();
    } while (msg.type !== "claude_event" || (msg as any).event?.type !== "result");

    client.send({ type: "get_deploy_history" } as any);
    const historyMsg = await client.receiveSkipLogs();

    expect(historyMsg.type).toBe("deploy_history");
    expect((historyMsg as any).deployments).toEqual([]);

    client.close();
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
