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

describe("Integration: PR creation — happy path", () => {
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
    await client.receiveSkipLogs(); // github_status (skip any runner messages)
    await client.receiveSkipLogs(); // github_search_results (user repos)

    client.send({
      type: "github_set_remote",
      name: "origin",
      url: "https://github.com/test-user/my-project.git",
    });
    await client.receiveSkipLogs(); // github_remotes (skip any runner messages)
  }

  it("creates a PR successfully with auth + remote configured", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    await setupSessionWithRemote(client);

    client.send({
      type: "github_create_pr",
      title: "Add JWT authentication",
      body: "## Summary\n\nAdded JWT auth",
      base: "main",
      draft: false,
    });

    const msg = await client.receiveSkipLogs();
    expect(msg.type).toBe("github_pr_created");
    expect((msg as any).success).toBe(true);
    expect((msg as any).url).toContain("github.com");
    expect((msg as any).number).toBe(1);

    client.close();
  });

  it("github_list_branches returns current branch and remote branches", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    await createSession(client);

    client.send({ type: "github_list_branches" });
    const msg = await client.receiveSkipLogs();

    expect(msg.type).toBe("github_branches");
    expect((msg as any).current).toBeDefined();
    expect(Array.isArray((msg as any).remote)).toBe(true);

    client.close();
  });
});
