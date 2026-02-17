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
      viteManager: new StubViteManager() as unknown as ViteManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      claudeFactory: () => {
        lastClaude = new FakeClaudeProcess();
        return lastClaude as unknown as ClaudeProcess;
      },
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
    await new Promise((r) => setTimeout(r, 200));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("get_system_prompt returns empty string when no file exists", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "get_system_prompt" } as any);
    const msg = await client.receive();

    expect(msg).toMatchObject({
      type: "system_prompt",
      content: "",
    });

    client.close();
  });

  it("set_system_prompt persists and confirms", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "set_system_prompt", content: "Always use TypeScript." } as any);
    const msg = await client.receive();

    expect(msg).toMatchObject({
      type: "system_prompt_saved",
      content: "Always use TypeScript.",
    });

    // Verify it was persisted to disk
    const filePath = path.join(tmpDir, ".shipit", "system-prompt.md");
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("Always use TypeScript.\n");

    client.close();
  });

  it("get_system_prompt returns saved content", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Set a prompt first
    client.send({ type: "set_system_prompt", content: "Use Tailwind CSS." } as any);
    await client.receive(); // system_prompt_saved

    // Now retrieve it
    client.send({ type: "get_system_prompt" } as any);
    const msg = await client.receive();

    expect(msg).toMatchObject({
      type: "system_prompt",
      content: "Use Tailwind CSS.",
    });

    client.close();
  });

  it("set_system_prompt with empty string deletes the file", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // First create a prompt
    client.send({ type: "set_system_prompt", content: "Something" } as any);
    await client.receive(); // system_prompt_saved

    // Now clear it
    client.send({ type: "set_system_prompt", content: "" } as any);
    const msg = await client.receive();

    expect(msg).toMatchObject({
      type: "system_prompt_saved",
      content: "",
    });

    // File should be deleted
    const filePath = path.join(tmpDir, ".shipit", "system-prompt.md");
    expect(fs.existsSync(filePath)).toBe(false);

    client.close();
  });

  it("set_system_prompt with whitespace-only string deletes the file", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // First create a prompt
    client.send({ type: "set_system_prompt", content: "Something" } as any);
    await client.receive(); // system_prompt_saved

    // Now send whitespace-only
    client.send({ type: "set_system_prompt", content: "   \n  \t  " } as any);
    const msg = await client.receive();

    expect(msg).toMatchObject({
      type: "system_prompt_saved",
      content: "",
    });

    client.close();
  });

  it("set_system_prompt trims whitespace", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "set_system_prompt", content: "  Use strict mode.  \n" } as any);
    const msg = await client.receive();

    expect(msg).toMatchObject({
      type: "system_prompt_saved",
      content: "Use strict mode.",
    });

    client.close();
  });

  it("set_system_prompt rejects content over 50KB", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    const hugeContent = "x".repeat(50_001);
    client.send({ type: "set_system_prompt", content: hugeContent } as any);
    const msg = await client.receive();

    expect(msg).toMatchObject({
      type: "error",
      message: "System prompt too long (max 50,000 characters)",
    });

    client.close();
  });

  it("set_system_prompt rejects non-string content", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "set_system_prompt", content: 42 } as any);
    const msg = await client.receive();

    expect(msg).toMatchObject({
      type: "error",
      message: "System prompt must be a string",
    });

    client.close();
  });

  it("system prompt is passed to ClaudeProcess.run() when set", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Set a system prompt
    client.send({ type: "set_system_prompt", content: "Be concise." } as any);
    await client.receive(); // system_prompt_saved

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
