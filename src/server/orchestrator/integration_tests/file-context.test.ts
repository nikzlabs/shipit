import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../auth.js";


import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  createTestCredentialStore,
} from "./test-helpers.js";

describe("Integration: File context attachments", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let latestClaude: FakeClaudeProcess | null = null;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-file-ctx-"));
    latestClaude = null;

    const sessionsFile = path.join(tmpDir, "sessions.json");
    const sessionManager = new SessionManager(sessionsFile);

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => {
        const cp = new FakeClaudeProcess();
        latestClaude = cp;
        return cp as any;
      },
      workspaceDir: tmpDir,
      serveStatic: false,
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

  it("sends file context prepended to the prompt", async () => {
    // Create a file in the workspace
    fs.writeFileSync(path.join(tmpDir, "hello.ts"), "const x = 42;");

    const client = await TestClient.connect(port);
    await client.receive(); // initial status

    client.send({
      type: "send_message",
      text: "Explain this file",
      files: [{ path: "hello.ts" }],
    });

    const claude = await waitForClaude(() => latestClaude);
    // The prompt should contain the file content in <file> tags
    expect(claude.lastPrompt).toContain('<file path="hello.ts">');
    expect(claude.lastPrompt).toContain("const x = 42;");
    expect(claude.lastPrompt).toContain("</file>");
    // Original text should follow
    expect(claude.lastPrompt).toContain("Explain this file");

    claude.finish();
    client.close();
  });

  it("attaches multiple files", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.ts"), "const a = 1;");
    fs.writeFileSync(path.join(tmpDir, "b.ts"), "const b = 2;");

    const client = await TestClient.connect(port);
    await client.receive();

    client.send({
      type: "send_message",
      text: "Compare these files",
      files: [{ path: "a.ts" }, { path: "b.ts" }],
    });

    const claude = await waitForClaude(() => latestClaude);
    expect(claude.lastPrompt).toContain('<file path="a.ts">');
    expect(claude.lastPrompt).toContain("const a = 1;");
    expect(claude.lastPrompt).toContain('<file path="b.ts">');
    expect(claude.lastPrompt).toContain("const b = 2;");

    claude.finish();
    client.close();
  });

  it("rejects path traversal in file attachments", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({
      type: "send_message",
      text: "Read this",
      files: [{ path: "../../etc/passwd" }],
    });

    const msg = await client.receiveType("error");
    expect((msg as any).message).toContain("Invalid file path");

    client.close();
  });

  it("rejects non-existent files", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({
      type: "send_message",
      text: "Read this",
      files: [{ path: "nonexistent.ts" }],
    });

    const msg = await client.receiveType("error");
    expect((msg as any).message).toContain("File not found");

    client.close();
  });

  it("rejects files that are too large", async () => {
    // Create a file over 100KB
    const bigContent = "x".repeat(101 * 1024);
    fs.writeFileSync(path.join(tmpDir, "big.ts"), bigContent);

    const client = await TestClient.connect(port);
    await client.receive();

    client.send({
      type: "send_message",
      text: "Read this",
      files: [{ path: "big.ts" }],
    });

    const msg = await client.receiveType("error");
    expect((msg as any).message).toContain("File too large");

    client.close();
  });

  it("rejects more than 10 file attachments", async () => {
    const files = [];
    for (let i = 0; i < 11; i++) {
      const name = `file${i}.ts`;
      fs.writeFileSync(path.join(tmpDir, name), `// file ${i}`);
      files.push({ path: name });
    }

    const client = await TestClient.connect(port);
    await client.receive();

    client.send({
      type: "send_message",
      text: "Read all these",
      files,
    });

    const msg = await client.receiveType("error");
    expect((msg as any).message).toContain("Maximum 10");

    client.close();
  });

  it("sends message without files when files array is empty", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({
      type: "send_message",
      text: "Hello",
      files: [],
    });

    const claude = await waitForClaude(() => latestClaude);
    // No file tags in the prompt
    expect(claude.lastPrompt).toBe("Hello");
    expect(claude.lastPrompt).not.toContain("<file");

    claude.finish();
    client.close();
  });

  it("rejects empty file path", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({
      type: "send_message",
      text: "Read this",
      files: [{ path: "" }],
    });

    const msg = await client.receiveType("error");
    expect((msg as any).message).toContain("File path is required");

    client.close();
  });
});
