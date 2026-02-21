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
} from "./test-helpers.js";

describe("Integration: Full reset", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let lastClaude: FakeClaudeProcess;

  beforeEach(async () => {
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-fullreset-"));
    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: new SessionManager(path.join(tmpDir, ".vibe-sessions.json")),
      previewManager: new StubPreviewManager() as unknown as PreviewManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      claudeFactory: () => {
        lastClaude = new FakeClaudeProcess();
        return lastClaude as unknown as ClaudeProcess;
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
    await new Promise((r) => setTimeout(r, 200));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("full_reset deletes all persistent data and sends full_reset_complete", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Create some persistent state: sessions file, a session dir, system prompt, etc.
    const sessionsDir = path.join(tmpDir, "sessions", "test-session");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, "file.txt"), "hello");

    const chatHistoryDir = path.join(tmpDir, ".vibe-chat-history");
    fs.mkdirSync(chatHistoryDir, { recursive: true });
    fs.writeFileSync(path.join(chatHistoryDir, "history.json"), "[]");

    const threadsDir = path.join(tmpDir, ".vibe-threads");
    fs.mkdirSync(threadsDir, { recursive: true });

    fs.writeFileSync(path.join(tmpDir, ".shipit-usage.json"), "{}");

    const shipitDir = path.join(tmpDir, ".shipit");
    fs.mkdirSync(shipitDir, { recursive: true });
    fs.writeFileSync(path.join(shipitDir, "system-prompt.md"), "Be concise.");

    fs.writeFileSync(path.join(tmpDir, ".github-token"), "ghp_fake");

    const deployDir = path.join(tmpDir, ".shipit-deploy");
    fs.mkdirSync(deployDir, { recursive: true });

    fs.writeFileSync(path.join(tmpDir, ".vibe-sessions.json"), "[]");

    // Send full_reset
    client.send({ type: "full_reset" } as any);
    const msg = await client.receiveSkipLogs();

    expect(msg).toMatchObject({ type: "full_reset_complete" });

    // Verify workspace is completely empty
    const remaining = fs.readdirSync(tmpDir);
    expect(remaining).toEqual([]);

    client.close();
  });

  it("full_reset removes root .git directory", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Simulate a root-level git repo (the bug: this survived the old reset)
    const gitDir = path.join(tmpDir, ".git");
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main");

    client.send({ type: "full_reset" } as any);
    const msg = await client.receiveSkipLogs();

    expect(msg).toMatchObject({ type: "full_reset_complete" });
    expect(fs.existsSync(gitDir)).toBe(false);

    client.close();
  });

  it("full_reset succeeds on an already-clean workspace (idempotent)", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // No persistent data exists — full_reset should still succeed
    client.send({ type: "full_reset" } as any);
    const msg = await client.receiveSkipLogs();

    expect(msg).toMatchObject({ type: "full_reset_complete" });

    client.close();
  });

  it("full_reset can be called twice in a row", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Create some state
    fs.mkdirSync(path.join(tmpDir, "sessions", "s1"), { recursive: true });

    // First reset
    client.send({ type: "full_reset" } as any);
    const msg1 = await client.receiveSkipLogs();
    expect(msg1).toMatchObject({ type: "full_reset_complete" });

    // Second reset — should still succeed
    client.send({ type: "full_reset" } as any);
    const msg2 = await client.receiveSkipLogs();
    expect(msg2).toMatchObject({ type: "full_reset_complete" });

    client.close();
  });
});
