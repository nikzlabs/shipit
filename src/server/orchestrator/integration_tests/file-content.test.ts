import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../auth.js";

import { ClaudeProcess } from "../../session/claude.js";

import type { FastifyInstance } from "fastify";
import {
  StubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
} from "./test-helpers.js";

describe("Integration: File content viewer", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let sessionId: string;
  let sessionDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-file-content-"));

    sessionId = crypto.randomUUID();
    sessionDir = path.join(tmpDir, "sessions", sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    const sessionsFile = path.join(tmpDir, "sessions.json");
    const sessionManager = new SessionManager(sessionsFile);
    sessionManager.track(sessionId, "Test session", sessionDir);

    const credentialStore = createTestCredentialStore(tmpDir);
    const git = new GitManager(sessionDir);
    await git.init();

    app = await buildApp({
      credentialStore,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      claudeFactory: () => new FakeClaudeProcess() as unknown as ClaudeProcess,
      workspaceDir: tmpDir,
      serveStatic: false,
    });
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

  it("returns file content", async () => {
    fs.writeFileSync(path.join(sessionDir, "hello.ts"), "const x = 42;");

    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/files/hello.ts` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.path).toBe("hello.ts");
    expect(body.content).toBe("const x = 42;");
  });

  it("returns nested file content", async () => {
    fs.mkdirSync(path.join(sessionDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "src", "app.ts"), "export default {};");

    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/files/src/app.ts` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.path).toBe("src/app.ts");
    expect(body.content).toBe("export default {};");
  });

  it("rejects path traversal", async () => {
    // Use percent-encoded path to bypass URL normalization
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/files/..%2F..%2Fetc%2Fpasswd`,
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("returns error for non-existent file", async () => {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/files/no-such-file.ts` });
    expect(res.statusCode).toBe(404);
  });

  it("returns isBinary for binary files", async () => {
    // Write a file with null bytes (binary indicator)
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]);
    fs.writeFileSync(path.join(sessionDir, "image.png"), buf);

    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/files/image.png` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.isBinary).toBe(true);
    expect(body.content).toContain("Binary file");
  });

  it("returns isBinary for large files", async () => {
    // Write a file over 1 MB
    const bigContent = "x".repeat(1_048_577);
    fs.writeFileSync(path.join(sessionDir, "big.txt"), bigContent);

    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/files/big.txt` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.isBinary).toBe(true);
    expect(body.content).toContain("too large");
  });
});
