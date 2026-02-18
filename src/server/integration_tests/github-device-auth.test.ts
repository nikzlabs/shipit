import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../auth.js";
import { GitHubAuthManager } from "../github-auth.js";
import { ViteManager } from "../vite-manager.js";
import { ClaudeProcess } from "../claude.js";
import { FileWatcher } from "../file-watcher.js";
import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubViteManager,
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  StubFileWatcher,
} from "./test-helpers.js";

describe("Integration: GitHub device authorization flow", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let githubAuthManager: StubGitHubAuthManager;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-gh-device-"));

    const sessionsFile = path.join(tmpDir, "sessions.json");
    const sessionManager = new SessionManager(sessionsFile);

    githubAuthManager = new StubGitHubAuthManager();

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      viteManager: new StubViteManager() as unknown as ViteManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: githubAuthManager as unknown as GitHubAuthManager,
      claudeFactory: () => new FakeClaudeProcess() as unknown as ClaudeProcess,
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
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("start flow returns device code and verification URI", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "github_device_auth_start" });
    const msg = await client.receive();

    expect(msg.type).toBe("github_device_auth_code");
    expect((msg as any).userCode).toBe("ABCD-1234");
    expect((msg as any).verificationUri).toBe("https://github.com/login/device");
    expect((msg as any).expiresIn).toBe(900);

    client.close();
  });

  it("successful auth returns success result and github_status update", async () => {
    // Queue: first poll returns pending, second returns success
    githubAuthManager.setDevicePollResults([
      { status: "pending" },
      { status: "success", token: "gho_test_token_123" },
    ]);

    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "github_device_auth_start" });
    const codeMsg = await client.receive();
    expect(codeMsg.type).toBe("github_device_auth_code");

    // Wait for polling to complete — should get success result and github_status
    const resultMsg = await client.receive(5000);
    expect(resultMsg.type).toBe("github_device_auth_result");
    expect((resultMsg as any).success).toBe(true);

    const statusMsg = await client.receive(5000);
    expect(statusMsg.type).toBe("github_status");
    expect((statusMsg as any).authenticated).toBe(true);

    client.close();
  });

  it("expired code returns failure result", async () => {
    githubAuthManager.setDevicePollResults([
      { status: "expired" },
    ]);

    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "github_device_auth_start" });
    const codeMsg = await client.receive();
    expect(codeMsg.type).toBe("github_device_auth_code");

    const resultMsg = await client.receive(5000);
    expect(resultMsg.type).toBe("github_device_auth_result");
    expect((resultMsg as any).success).toBe(false);
    expect((resultMsg as any).message).toContain("expired");

    client.close();
  });

  it("poll error returns failure result", async () => {
    githubAuthManager.setDevicePollResults([
      { status: "error", message: "access_denied" },
    ]);

    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "github_device_auth_start" });
    const codeMsg = await client.receive();
    expect(codeMsg.type).toBe("github_device_auth_code");

    const resultMsg = await client.receive(5000);
    expect(resultMsg.type).toBe("github_device_auth_result");
    expect((resultMsg as any).success).toBe(false);
    expect((resultMsg as any).message).toBe("access_denied");

    client.close();
  });

  it("start flow error returns failure result", async () => {
    githubAuthManager.setDeviceAuthError("Network error");

    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "github_device_auth_start" });
    const resultMsg = await client.receive();

    expect(resultMsg.type).toBe("github_device_auth_result");
    expect((resultMsg as any).success).toBe(false);
    expect((resultMsg as any).message).toBe("Network error");

    client.close();
  });
});
