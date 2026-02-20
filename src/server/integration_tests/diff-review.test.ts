import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { buildApp } from "../index.js";
import { GitManager } from "../git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../auth.js";
import { PreviewManager } from "../preview-manager.js";
import { ClaudeProcess } from "../claude.js";
import { FileWatcher } from "../file-watcher.js";
import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubPreviewManager,
  StubAuthManager,
  FakeClaudeProcess,
  StubFileWatcher,
} from "./test-helpers.js";

describe("Integration: Diff review", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionDir: string;
  let sessionManager: SessionManager;
  let sessionId: string;
  let git: GitManager;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-diff-review-"));

    sessionId = crypto.randomUUID();
    sessionDir = path.join(tmpDir, "sessions", sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    git = new GitManager(sessionDir);
    await git.init();

    const sessionsFile = path.join(tmpDir, "sessions.json");
    sessionManager = new SessionManager(sessionsFile);
    sessionManager.track(sessionId, "Test session", sessionDir);

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      previewManager: new StubPreviewManager() as unknown as PreviewManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      claudeFactory: () => new FakeClaudeProcess() as unknown as ClaudeProcess,
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
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors
    }
  });

  /** Helper: activate session and consume initial messages. */
  async function activateSession(client: TestClient) {
    client.send({ type: "get_chat_history", sessionId });
    await client.receiveType("chat_history"); // skip side-effects from activateSession
  }

  it("get_turn_diff returns file changes between two commits", async () => {
    // Create initial file and commit
    fs.writeFileSync(path.join(sessionDir, "hello.ts"), "const x = 1;\n");
    const hash1 = await git.autoCommit("Add hello.ts");

    // Modify the file and commit
    fs.writeFileSync(path.join(sessionDir, "hello.ts"), "const x = 2;\nconst y = 3;\n");
    const hash2 = await git.autoCommit("Modify hello.ts");

    const client = await TestClient.connect(port);
    await client.receive(); // preview_status
    await activateSession(client);

    client.send({ type: "get_turn_diff", fromCommit: hash1!, toCommit: hash2! });
    const msg = await client.receive();

    expect(msg.type).toBe("turn_diff");
    const diff = msg as any;
    expect(diff.fromCommit).toBe(hash1);
    expect(diff.toCommit).toBe(hash2);
    expect(diff.files.length).toBe(1);
    expect(diff.files[0].path).toBe("hello.ts");
    expect(diff.files[0].status).toBe("modified");
    expect(diff.files[0].oldContent).toContain("const x = 1;");
    expect(diff.files[0].newContent).toContain("const x = 2;");

    client.close();
  });

  it("get_turn_diff handles added files", async () => {
    const log = await git.log();
    const initialHash = log[0].hash;

    // Add a new file
    fs.writeFileSync(path.join(sessionDir, "new-file.ts"), "export const foo = 42;\n");
    const hash2 = await git.autoCommit("Add new-file.ts");

    const client = await TestClient.connect(port);
    await client.receive(); // preview_status
    await activateSession(client);

    client.send({ type: "get_turn_diff", fromCommit: initialHash, toCommit: hash2! });
    const msg = await client.receive();

    expect(msg.type).toBe("turn_diff");
    const diff = msg as any;
    expect(diff.files.length).toBe(1);
    expect(diff.files[0].status).toBe("added");
    expect(diff.files[0].oldContent).toBe("");
    expect(diff.files[0].newContent).toContain("export const foo = 42;");

    client.close();
  });

  it("get_turn_diff handles deleted files", async () => {
    // Create a file
    fs.writeFileSync(path.join(sessionDir, "to-delete.ts"), "delete me\n");
    const hash1 = await git.autoCommit("Add to-delete.ts");

    // Delete the file
    fs.unlinkSync(path.join(sessionDir, "to-delete.ts"));
    const hash2 = await git.autoCommit("Delete to-delete.ts");

    const client = await TestClient.connect(port);
    await client.receive(); // preview_status
    await activateSession(client);

    client.send({ type: "get_turn_diff", fromCommit: hash1!, toCommit: hash2! });
    const msg = await client.receive();

    expect(msg.type).toBe("turn_diff");
    const diff = msg as any;
    expect(diff.files.length).toBe(1);
    expect(diff.files[0].status).toBe("deleted");
    expect(diff.files[0].oldContent).toContain("delete me");
    expect(diff.files[0].newContent).toBe("");

    client.close();
  });

  it("get_turn_diff returns empty for no changes", async () => {
    const log = await git.log();
    const hash = log[0].hash;

    const client = await TestClient.connect(port);
    await client.receive(); // preview_status
    await activateSession(client);

    // Same commit for from and to — no changes
    client.send({ type: "get_turn_diff", fromCommit: hash, toCommit: hash });
    const msg = await client.receive();

    expect(msg.type).toBe("turn_diff");
    const diff = msg as any;
    expect(diff.files.length).toBe(0);
    expect(diff.stats.filesChanged).toBe(0);

    client.close();
  });

  it("get_turn_diff returns error for missing commit params", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status
    await activateSession(client);

    client.send({ type: "get_turn_diff", fromCommit: "", toCommit: "" });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toContain("get_turn_diff requires");

    client.close();
  });

  it("reject_changes reverts specific files", async () => {
    // Create two files
    fs.writeFileSync(path.join(sessionDir, "keep.ts"), "keep this\n");
    fs.writeFileSync(path.join(sessionDir, "revert.ts"), "original\n");
    const hash1 = await git.autoCommit("Add files");

    // Modify both
    fs.writeFileSync(path.join(sessionDir, "keep.ts"), "modified keep\n");
    fs.writeFileSync(path.join(sessionDir, "revert.ts"), "modified revert\n");
    await git.autoCommit("Modify files");

    const client = await TestClient.connect(port);
    await client.receive(); // preview_status
    await activateSession(client);

    // Reject only revert.ts
    client.send({ type: "reject_changes", fromCommit: hash1!, files: ["revert.ts"] });
    const msg = await client.receive();

    expect(msg.type).toBe("reject_changes_complete");
    const result = msg as any;
    expect(result.revertedFiles).toEqual(["revert.ts"]);

    // Verify the file was reverted
    const revertContent = fs.readFileSync(path.join(sessionDir, "revert.ts"), "utf-8");
    expect(revertContent).toBe("original\n");

    // Verify the other file was not reverted
    const keepContent = fs.readFileSync(path.join(sessionDir, "keep.ts"), "utf-8");
    expect(keepContent).toBe("modified keep\n");

    client.close();
  });

  it("reject_changes with empty files array reverts all (rollback)", async () => {
    const log = await git.log();
    const initialHash = log[0].hash;

    // Add a file
    fs.writeFileSync(path.join(sessionDir, "new.ts"), "new content\n");
    await git.autoCommit("Add new.ts");

    const client = await TestClient.connect(port);
    await client.receive(); // preview_status
    await activateSession(client);

    // Reject all changes
    client.send({ type: "reject_changes", fromCommit: initialHash, files: [] });
    const msg = await client.receive();

    expect(msg.type).toBe("reject_changes_complete");
    expect((msg as any).commitHash).toBe(initialHash);

    // File should be gone after full rollback
    expect(fs.existsSync(path.join(sessionDir, "new.ts"))).toBe(false);

    client.close();
  });

  it("reject_changes returns error for missing fromCommit", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status
    await activateSession(client);

    client.send({ type: "reject_changes", fromCommit: "", files: [] });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toContain("reject_changes requires");

    client.close();
  });

  it("get_turn_diff handles multiple file changes", async () => {
    const log = await git.log();
    const initialHash = log[0].hash;

    // Create multiple files
    fs.writeFileSync(path.join(sessionDir, "a.ts"), "file a\n");
    fs.writeFileSync(path.join(sessionDir, "b.ts"), "file b\n");
    fs.writeFileSync(path.join(sessionDir, "c.ts"), "file c\n");
    const hash2 = await git.autoCommit("Add three files");

    const client = await TestClient.connect(port);
    await client.receive(); // preview_status
    await activateSession(client);

    client.send({ type: "get_turn_diff", fromCommit: initialHash, toCommit: hash2! });
    const msg = await client.receive();

    expect(msg.type).toBe("turn_diff");
    const diff = msg as any;
    expect(diff.files.length).toBe(3);
    expect(diff.stats.filesChanged).toBe(3);
    const paths = diff.files.map((f: any) => f.path).sort();
    expect(paths).toEqual(["a.ts", "b.ts", "c.ts"]);

    client.close();
  });
});
