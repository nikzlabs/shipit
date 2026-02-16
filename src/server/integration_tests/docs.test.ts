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
} from "./test-helpers.js";

describe("Integration: Docs", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-docs-"));

    // Create a markdown file for doc tests
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# Hello\nWorld");

    const gitManager = new GitManager(tmpDir);
    await gitManager.init();

    const sessionsFile = path.join(tmpDir, "sessions.json");
    const sessionManager = new SessionManager(sessionsFile);

    app = await buildApp({
      gitManager,
      sessionManager,
      viteManager: new StubViteManager() as unknown as ViteManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
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
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors — temp dir will be cleaned by OS
    }
  });

  it("list_docs returns markdown files in workspace", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "list_docs" });
    const msg = await client.receive();

    expect(msg.type).toBe("doc_list");
    expect((msg as any).files).toContain("README.md");

    client.close();
  });

  it("get_doc returns file content", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "get_doc", path: "README.md" });
    const msg = await client.receive();

    expect(msg.type).toBe("doc_content");
    expect((msg as any).path).toBe("README.md");
    expect((msg as any).content).toBe("# Hello\nWorld");

    client.close();
  });

  it("get_doc rejects path traversal", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "get_doc", path: "../../etc/passwd" });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("Invalid path");

    client.close();
  });

  it("get_doc returns error for non-existent file", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "get_doc", path: "does-not-exist.md" });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toContain("Failed to read doc");

    client.close();
  });
});
