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

describe("Integration: System prompt", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let lastClaude: FakeClaudeProcess = null as any;

  beforeEach(async () => {
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-sysprompt-"));
    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: new SessionManager(path.join(tmpDir, "sessions.json")),
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

  it("get_global_settings returns empty system prompt when no file exists", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "get_global_settings" } as any);
    const msg = await client.receive();

    expect(msg).toMatchObject({
      type: "global_settings",
      systemPrompt: "",
    });

    client.close();
  });

  it("save_global_settings persists system prompt and confirms", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "save_global_settings", systemPrompt: "Always use TypeScript." } as any);
    const msg = await client.receive();

    expect(msg).toMatchObject({
      type: "global_settings",
      systemPrompt: "Always use TypeScript.",
    });

    // Verify it was persisted to disk
    const filePath = path.join(tmpDir, ".shipit", "system-prompt.md");
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("Always use TypeScript.\n");

    client.close();
  });

  it("get_global_settings returns saved system prompt", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Set a prompt first
    client.send({ type: "save_global_settings", systemPrompt: "Use Tailwind CSS." } as any);
    await client.receive(); // global_settings

    // Now retrieve it
    client.send({ type: "get_global_settings" } as any);
    const msg = await client.receive();

    expect(msg).toMatchObject({
      type: "global_settings",
      systemPrompt: "Use Tailwind CSS.",
    });

    client.close();
  });

  it("save_global_settings with empty system prompt deletes the file", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // First create a prompt
    client.send({ type: "save_global_settings", systemPrompt: "Something" } as any);
    await client.receive(); // global_settings

    // Now clear it
    client.send({ type: "save_global_settings", systemPrompt: "" } as any);
    const msg = await client.receive();

    expect(msg).toMatchObject({
      type: "global_settings",
      systemPrompt: "",
    });

    // File should be deleted
    const filePath = path.join(tmpDir, ".shipit", "system-prompt.md");
    expect(fs.existsSync(filePath)).toBe(false);

    client.close();
  });

  it("save_global_settings with whitespace-only system prompt deletes the file", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // First create a prompt
    client.send({ type: "save_global_settings", systemPrompt: "Something" } as any);
    await client.receive(); // global_settings

    // Now send whitespace-only
    client.send({ type: "save_global_settings", systemPrompt: "   \n  \t  " } as any);
    const msg = await client.receive();

    expect(msg).toMatchObject({
      type: "global_settings",
      systemPrompt: "",
    });

    client.close();
  });

  it("save_global_settings trims whitespace from system prompt", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "save_global_settings", systemPrompt: "  Use strict mode.  \n" } as any);
    const msg = await client.receive();

    expect(msg).toMatchObject({
      type: "global_settings",
      systemPrompt: "Use strict mode.",
    });

    client.close();
  });

  it("save_global_settings rejects system prompt over 50KB", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    const hugeContent = "x".repeat(50_001);
    client.send({ type: "save_global_settings", systemPrompt: hugeContent } as any);
    const msg = await client.receive();

    expect(msg).toMatchObject({
      type: "error",
      message: "System prompt too long (max 50,000 characters)",
    });

    client.close();
  });

  it("system prompt is passed to ClaudeProcess.run() when set", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Set a system prompt
    client.send({ type: "save_global_settings", systemPrompt: "Be concise." } as any);
    await client.receive(); // global_settings

    // Send a message to Claude
    client.send({ type: "send_message", text: "Hello" });
    await waitForClaude(() => lastClaude);

    expect(lastClaude.lastSystemPrompt).toBe("Be concise.");

    client.close();
  });

  it("system prompt is undefined when no file exists", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "Hello" });
    await waitForClaude(() => lastClaude);

    expect(lastClaude.lastSystemPrompt).toBeUndefined();

    client.close();
  });
});
