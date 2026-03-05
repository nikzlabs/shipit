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
import {
  StubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";

describe("Integration: Diff review", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let sessionDir: string;
  let sessionManager: SessionManager;
  let sessionId: string;
  let git: GitManager;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-diff-review-"));

    sessionId = crypto.randomUUID();
    sessionDir = path.join(tmpDir, "sessions", sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    const credentialStore = createTestCredentialStore(tmpDir);
    git = new GitManager(sessionDir);
    await git.init();

    sessionManager = new SessionManager(dbManager);
    sessionManager.track(sessionId, "Test session", sessionDir);

    app = await buildApp({
      credentialStore,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => new FakeClaudeProcess() as any,
      workspaceDir: tmpDir,
      serveStatic: false,
    });

    await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterEach(async () => {
    dbManager.close();
    await app.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("GET /api/sessions/:id/git/diff returns file changes between two commits", async () => {
    // Create initial file and commit
    fs.writeFileSync(path.join(sessionDir, "hello.ts"), "const x = 1;\n");
    const hash1 = await git.autoCommit("Add hello.ts");

    // Modify the file and commit
    fs.writeFileSync(path.join(sessionDir, "hello.ts"), "const x = 2;\nconst y = 3;\n");
    const hash2 = await git.autoCommit("Modify hello.ts");

    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/git/diff?from=${hash1}&to=${hash2}` });
    expect(res.statusCode).toBe(200);
    const diff = res.json();
    expect(diff.fromCommit).toBe(hash1);
    expect(diff.toCommit).toBe(hash2);
    expect(diff.files.length).toBe(1);
    expect(diff.files[0].path).toBe("hello.ts");
    expect(diff.files[0].status).toBe("modified");
    expect(diff.files[0].oldContent).toContain("const x = 1;");
    expect(diff.files[0].newContent).toContain("const x = 2;");
  });

  it("GET /api/sessions/:id/git/diff handles added files", async () => {
    const log = await git.log();
    const initialHash = log[0].hash;

    // Add a new file
    fs.writeFileSync(path.join(sessionDir, "new-file.ts"), "export const foo = 42;\n");
    const hash2 = await git.autoCommit("Add new-file.ts");

    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/git/diff?from=${initialHash}&to=${hash2}` });
    expect(res.statusCode).toBe(200);
    const diff = res.json();
    expect(diff.files.length).toBe(1);
    expect(diff.files[0].status).toBe("added");
    expect(diff.files[0].oldContent).toBe("");
    expect(diff.files[0].newContent).toContain("export const foo = 42;");
  });

  it("GET /api/sessions/:id/git/diff handles deleted files", async () => {
    // Create a file
    fs.writeFileSync(path.join(sessionDir, "to-delete.ts"), "delete me\n");
    const hash1 = await git.autoCommit("Add to-delete.ts");

    // Delete the file
    fs.unlinkSync(path.join(sessionDir, "to-delete.ts"));
    const hash2 = await git.autoCommit("Delete to-delete.ts");

    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/git/diff?from=${hash1}&to=${hash2}` });
    expect(res.statusCode).toBe(200);
    const diff = res.json();
    expect(diff.files.length).toBe(1);
    expect(diff.files[0].status).toBe("deleted");
    expect(diff.files[0].oldContent).toContain("delete me");
    expect(diff.files[0].newContent).toBe("");
  });

  it("GET /api/sessions/:id/git/diff returns empty for no changes", async () => {
    const log = await git.log();
    const hash = log[0].hash;

    // Same commit for from and to — no changes
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/git/diff?from=${hash}&to=${hash}` });
    expect(res.statusCode).toBe(200);
    const diff = res.json();
    expect(diff.files.length).toBe(0);
    expect(diff.stats.filesChanged).toBe(0);
  });

  it("GET /api/sessions/:id/git/diff returns 400 for missing commit params", async () => {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/git/diff` });
    expect(res.statusCode).toBe(400);
  });

  it("GET /api/sessions/:id/git/diff handles multiple file changes", async () => {
    const log = await git.log();
    const initialHash = log[0].hash;

    // Create multiple files
    fs.writeFileSync(path.join(sessionDir, "a.ts"), "file a\n");
    fs.writeFileSync(path.join(sessionDir, "b.ts"), "file b\n");
    fs.writeFileSync(path.join(sessionDir, "c.ts"), "file c\n");
    const hash2 = await git.autoCommit("Add three files");

    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/git/diff?from=${initialHash}&to=${hash2}` });
    expect(res.statusCode).toBe(200);
    const diff = res.json();
    expect(diff.files.length).toBe(3);
    expect(diff.stats.filesChanged).toBe(3);
    const paths = diff.files.map((f: any) => f.path).sort();
    expect(paths).toEqual(["a.ts", "b.ts", "c.ts"]);
  });
});
