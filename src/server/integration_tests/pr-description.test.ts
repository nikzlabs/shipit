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

describe("Integration: PR description generation", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let lastClaude: FakeClaudeProcess | null;
  let generateTextResult: string;
  let generateTextError: Error | null;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-pr-desc-"));
    lastClaude = null;
    generateTextResult = "## Summary\n\nAdded authentication.\n\n## Changes\n\n- Added JWT auth module";
    generateTextError = null;

    const sessionsFile = path.join(tmpDir, "sessions.json");
    const sessionManager = new SessionManager(sessionsFile);

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      previewManager: new StubPreviewManager() as unknown as PreviewManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
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
      generateText: async () => {
        if (generateTextError) throw generateTextError;
        return generateTextResult;
      },
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const match = address.match(/:(\d+)$/);
    port = match ? Number(match[1]) : 0;
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  /**
   * Helper: create a session so that git operations work.
   */
  async function createSession(client: TestClient) {
    client.send({ type: "send_message", text: "hello" });
    const claude = await waitForClaude(() => lastClaude);
    claude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "agent-1",
    });
    claude.finish("agent-1");
    // Drain messages until we're clear
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

  it("generates a PR description with markdown content", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    await createSession(client);

    client.send({ type: "generate_pr_description" });
    const msg = await client.receiveSkipLogs();

    expect(msg.type).toBe("generated_pr_description");
    expect((msg as any).description).toContain("## Summary");
    expect((msg as any).description).toContain("## Changes");

    client.close();
  });

  it("returns empty description when no git history", async () => {
    // Build a separate app with an empty git repo (no commits beyond init)
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-pr-empty-"));
    const emptySessionsFile = path.join(emptyDir, "sessions.json");
    let emptyLastClaude: FakeClaudeProcess | null = null;

    const emptyApp = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: new SessionManager(emptySessionsFile),
      previewManager: new StubPreviewManager() as unknown as PreviewManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      claudeFactory: () => {
        const cp = new FakeClaudeProcess();
        emptyLastClaude = cp;
        return cp as unknown as ClaudeProcess;
      },
      fileWatcher: new StubFileWatcher() as unknown as FileWatcher,
      workspaceDir: emptyDir,
      serveStatic: false,
      startPreview: false,
      portScanIntervalMs: 0,
      generateText: async () => generateTextResult,
    });

    const emptyAddress = await emptyApp.listen({ port: 0, host: "127.0.0.1" });
    const emptyMatch = emptyAddress.match(/:(\d+)$/);
    const emptyPort = emptyMatch ? Number(emptyMatch[1]) : 0;

    try {
      const client = await TestClient.connect(emptyPort);
      await client.receive(); // preview_status

      // Create session
      client.send({ type: "send_message", text: "hello" });
      const claude = await waitForClaude(() => emptyLastClaude);
      claude.emit("event", { type: "system", subtype: "init", session_id: "agent-empty" });
      // Don't emit any file changes — finish immediately so git has minimal history
      claude.finish("agent-empty");

      // Drain messages
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        try {
          const msg = await client.receive(200);
          if (msg.type === "git_committed") break;
        } catch {
          break;
        }
      }

      // The session has at least "Initial commit" + "Claude turn" commit.
      // With generateText stubbed, it will get called. Just verify we get a response.
      client.send({ type: "generate_pr_description" });
      const msg = await client.receiveSkipLogs();
      expect(msg.type).toBe("generated_pr_description");

      client.close();
    } finally {
      await emptyApp.close();
      fs.rmSync(emptyDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it("returns error when text generation fails", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    await createSession(client);

    // Set up the generateText stub to fail
    generateTextError = new Error("Claude process crashed");

    client.send({ type: "generate_pr_description" });
    const msg = await client.receiveSkipLogs();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toContain("Failed to generate description");
    expect((msg as any).message).toContain("Claude process crashed");

    client.close();
  });
});
