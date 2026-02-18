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

describe("Integration: File content viewer", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-file-content-"));

    const sessionsFile = path.join(tmpDir, "sessions.json");
    const sessionManager = new SessionManager(sessionsFile);

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
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

  it("get_file_content returns file content", async () => {
    fs.writeFileSync(path.join(tmpDir, "hello.ts"), "const x = 42;");

    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "get_file_content", path: "hello.ts" });
    const msg = await client.receive();

    expect(msg.type).toBe("file_content");
    expect((msg as any).path).toBe("hello.ts");
    expect((msg as any).content).toBe("const x = 42;");

    client.close();
  });

  it("get_file_content returns nested file content", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "app.ts"), "export default {};");

    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "get_file_content", path: "src/app.ts" });
    const msg = await client.receive();

    expect(msg.type).toBe("file_content");
    expect((msg as any).path).toBe("src/app.ts");
    expect((msg as any).content).toBe("export default {};");

    client.close();
  });

  it("get_file_content rejects path traversal", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "get_file_content", path: "../../etc/passwd" });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("Invalid path");

    client.close();
  });

  it("get_file_content returns error for non-existent file", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "get_file_content", path: "no-such-file.ts" });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toContain("Failed to read file");

    client.close();
  });

  it("get_file_content returns isBinary for binary files", async () => {
    // Write a file with null bytes (binary indicator)
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]);
    fs.writeFileSync(path.join(tmpDir, "image.png"), buf);

    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "get_file_content", path: "image.png" });
    const msg = await client.receive();

    expect(msg.type).toBe("file_content");
    expect((msg as any).isBinary).toBe(true);
    expect((msg as any).content).toContain("Binary file");

    client.close();
  });

  it("get_file_content returns isBinary for large files", async () => {
    // Write a file over 1 MB
    const bigContent = "x".repeat(1_048_577);
    fs.writeFileSync(path.join(tmpDir, "big.txt"), bigContent);

    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "get_file_content", path: "big.txt" });
    const msg = await client.receive();

    expect(msg.type).toBe("file_content");
    expect((msg as any).isBinary).toBe(true);
    expect((msg as any).content).toContain("too large");

    client.close();
  });
});
