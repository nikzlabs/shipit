import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../auth.js";
import type { FastifyInstance } from "fastify";
import type { UploadedFile } from "../../shared/types.js";
import {
  StubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";

/**
 * Build a multipart/form-data body manually for app.inject().
 */
function buildMultipartBody(
  files: { name: string; filename: string; content: Buffer }[],
): { payload: Buffer; boundary: string } {
  const boundary = `----FormBoundary${crypto.randomUUID().replace(/-/g, "")}`;
  const parts: Buffer[] = [];

  for (const file of files) {
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
    ));
    parts.push(file.content);
    parts.push(Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));

  return { payload: Buffer.concat(parts), boundary };
}

describe("Integration: File upload", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let sessionId: string;
  let sessionDir: string;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-upload-"));

    sessionId = crypto.randomUUID();
    sessionDir = path.join(tmpDir, "sessions", sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    const sessionManager = new SessionManager(dbManager);
    sessionManager.track(sessionId, "Test session", sessionDir);

    const credentialStore = createTestCredentialStore(tmpDir);
    const git = new GitManager(sessionDir);
    await git.init();

    app = await buildApp({
      credentialStore,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => new FakeClaudeProcess() as any,
      workspaceDir: tmpDir,
      serveStatic: false,
    });
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("uploads a single file and returns metadata", async () => {
    const { payload, boundary } = buildMultipartBody([
      { name: "file", filename: "data.csv", content: Buffer.from("a,b,c\n1,2,3") },
    ]);

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/files/uploads`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { files: UploadedFile[] };
    expect(body.files).toHaveLength(1);
    expect(body.files[0].name).toBe("data.csv");
    expect(body.files[0].path).toBe("/uploads/data.csv");
    expect(body.files[0].size).toBe(11);
    expect(body.files[0].type).toBe("upload");

    // Verify file was written to disk
    const filePath = path.join(sessionDir, "uploads", "data.csv");
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("a,b,c\n1,2,3");
  });

  it("uploads multiple files", async () => {
    const { payload, boundary } = buildMultipartBody([
      { name: "file", filename: "a.txt", content: Buffer.from("hello") },
      { name: "file", filename: "b.txt", content: Buffer.from("world") },
    ]);

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/files/uploads`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { files: UploadedFile[] };
    expect(body.files).toHaveLength(2);
  });

  it("handles filename collision with numeric suffix", async () => {
    // Upload same filename twice
    const { payload: p1, boundary: b1 } = buildMultipartBody([
      { name: "file", filename: "file.txt", content: Buffer.from("first") },
    ]);
    await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/files/uploads`,
      headers: { "content-type": `multipart/form-data; boundary=${b1}` },
      payload: p1,
    });

    const { payload: p2, boundary: b2 } = buildMultipartBody([
      { name: "file", filename: "file.txt", content: Buffer.from("second") },
    ]);
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/files/uploads`,
      headers: { "content-type": `multipart/form-data; boundary=${b2}` },
      payload: p2,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { files: UploadedFile[] };
    expect(body.files[0].name).toBe("file-1.txt");
  });

  it("sanitizes path traversal in filenames", async () => {
    const { payload, boundary } = buildMultipartBody([
      { name: "file", filename: "../../etc/passwd", content: Buffer.from("nope") },
    ]);

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/files/uploads`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { files: UploadedFile[] };
    expect(body.files[0].name).toBe("passwd");
    // File should be in the uploads dir, not in /etc
    expect(fs.existsSync(path.join(sessionDir, "uploads", "passwd"))).toBe(true);
  });

  it("returns 404 for nonexistent session", async () => {
    const { payload, boundary } = buildMultipartBody([
      { name: "file", filename: "test.txt", content: Buffer.from("hi") },
    ]);

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/nonexistent/files/uploads`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(res.statusCode).toBe(404);
  });

  describe("GET /files/uploads — list uploads", () => {
    it("lists uploaded files", async () => {
      // Upload a file first
      const uploadsDir = path.join(sessionDir, "uploads");
      fs.mkdirSync(uploadsDir, { recursive: true });
      fs.writeFileSync(path.join(uploadsDir, "data.csv"), "a,b,c");
      fs.writeFileSync(path.join(uploadsDir, "image.png"), Buffer.alloc(100));

      const res = await app.inject({
        method: "GET",
        url: `/api/sessions/${sessionId}/files/uploads`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as { files: UploadedFile[] };
      expect(body.files).toHaveLength(2);
      expect(body.files.map((f) => f.name).sort()).toEqual(["data.csv", "image.png"]);
      expect(body.files.every((f) => f.type === "upload")).toBe(true);
    });

    it("returns empty list when no uploads exist", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/sessions/${sessionId}/files/uploads`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as { files: UploadedFile[] };
      expect(body.files).toEqual([]);
    });

    it("returns 404 for nonexistent session", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/sessions/nonexistent/files/uploads`,
      });

      expect(res.statusCode).toBe(404);
    });
  });
});
