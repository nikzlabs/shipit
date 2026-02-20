import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../auth.js";
import { GitHubAuthManager } from "../github-auth.js";
import { PreviewManager } from "../preview-manager.js";
import { ClaudeProcess } from "../claude.js";
import { FileWatcher } from "../file-watcher.js";
import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubPreviewManager,
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  StubFileWatcher,
  waitForClaude,
} from "./test-helpers.js";

describe("Integration: PR creation — validation errors", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let githubAuthManager: StubGitHubAuthManager;
  let lastClaude: FakeClaudeProcess | null;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-pr-"));
    lastClaude = null;

    const sessionsFile = path.join(tmpDir, "sessions.json");
    const sessionManager = new SessionManager(sessionsFile);

    githubAuthManager = new StubGitHubAuthManager();

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      previewManager: new StubPreviewManager() as unknown as PreviewManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: githubAuthManager as unknown as GitHubAuthManager,
      claudeFactory: () => {
        const cp = new FakeClaudeProcess();
        lastClaude = cp;
        return cp as unknown as ClaudeProcess;
      },
      fileWatcher: new StubFileWatcher() as unknown as FileWatcher,
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
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  async function createSession(client: TestClient) {
    client.send({ type: "send_message", text: "hello" });
    const claude = await waitForClaude(() => lastClaude);
    claude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "agent-1",
    });
    claude.finish("agent-1");
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try {
        const msg = await client.receive(200);
        if (msg.type === "git_committed") break;
      } catch {
        break;
      }
    }
  }

  async function setupSessionWithRemote(client: TestClient) {
    await createSession(client);

    client.send({ type: "github_set_token", token: "ghp_test" });
    await client.receive(); // github_status
    await client.receive(); // github_search_results (user repos)

    client.send({
      type: "github_set_remote",
      name: "origin",
      url: "https://github.com/test-user/my-project.git",
    });
    await client.receive(); // github_remotes
  }

  it("returns error when not authenticated with GitHub", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    await createSession(client);

    client.send({
      type: "github_create_pr",
      title: "Some PR",
      body: "",
      base: "main",
    });

    const msg = await client.receiveSkipLogs();
    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("Not authenticated with GitHub");

    client.close();
  });

  it("returns error when no origin remote is configured", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    await createSession(client);

    // Authenticate but don't add a remote
    client.send({ type: "github_set_token", token: "ghp_test" });
    await client.receive(); // github_status
    await client.receive(); // github_search_results (user repos)

    client.send({
      type: "github_create_pr",
      title: "Some PR",
      body: "",
      base: "main",
    });

    const msg = await client.receiveSkipLogs();
    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("No 'origin' remote configured");

    client.close();
  });

  it("returns error when remote is not a GitHub URL", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    await createSession(client);

    // Authenticate
    client.send({ type: "github_set_token", token: "ghp_test" });
    await client.receive(); // github_status
    await client.receive(); // github_search_results (user repos)

    // Add a non-GitHub remote
    client.send({
      type: "github_set_remote",
      name: "origin",
      url: "https://gitlab.com/user/repo.git",
    });
    await client.receive(); // github_remotes

    client.send({
      type: "github_create_pr",
      title: "Some PR",
      body: "",
      base: "main",
    });

    const msg = await client.receiveSkipLogs();
    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("Remote URL is not a GitHub repository");

    client.close();
  });

  it("returns error when title is empty", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    await setupSessionWithRemote(client);

    client.send({
      type: "github_create_pr",
      title: "",
      body: "some body",
      base: "main",
    });

    const msg = await client.receiveSkipLogs();
    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("PR title is required");

    client.close();
  });

  it("returns error when title is too long", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    await setupSessionWithRemote(client);

    client.send({
      type: "github_create_pr",
      title: "x".repeat(257),
      body: "",
      base: "main",
    });

    const msg = await client.receiveSkipLogs();
    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("PR title too long (max 256 characters)");

    client.close();
  });

  it("returns error when base branch is empty", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    await setupSessionWithRemote(client);

    client.send({
      type: "github_create_pr",
      title: "Valid Title",
      body: "",
      base: "",
    });

    const msg = await client.receiveSkipLogs();
    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("Base branch is required");

    client.close();
  });
});
