import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import { DatabaseManager } from "../../shared/database.js";
import {
  StubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";

describe("Integration: /persist in the Files panel", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let sessionId: string;
  let workspaceDir: string;
  let scratchDir: string;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "persist-files-"));
    sessionId = crypto.randomUUID();
    const sessionRoot = path.join(tmpDir, "sessions", sessionId);
    workspaceDir = path.join(sessionRoot, "workspace");
    scratchDir = path.join(sessionRoot, "scratch");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(path.join(scratchDir, "notes"), { recursive: true });
    fs.writeFileSync(path.join(scratchDir, "notes", "plan.md"), "# Plan");
    fs.writeFileSync(path.join(scratchDir, "chart.html"), "<h1>chart</h1>");

    const sessionManager = new SessionManager(dbManager);
    sessionManager.track(sessionId, "Test session", workspaceDir);

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
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
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it("lists /persist beside the workspace tree, with absolute paths", async () => {
    fs.writeFileSync(path.join(workspaceDir, "README.md"), "hi");

    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/files` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tree.map((n: { path: string }) => n.path)).toEqual(["README.md"]);
    expect(body.persist).toEqual([
      {
        name: "notes",
        path: "/persist/notes",
        type: "directory",
        children: [{ name: "plan.md", path: "/persist/notes/plan.md", type: "file" }],
      },
      { name: "chart.html", path: "/persist/chart.html", type: "file" },
    ]);
  });

  it("returns a /persist file's content", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/files/%2Fpersist/chart.html`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ path: "/persist/chart.html", content: "<h1>chart</h1>" });
  });

  it("returns a /persist markdown file through the docs route", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/docs/%2Fpersist/notes/plan.md`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ content: "# Plan" });
  });

  it("downloads a /persist file", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/files/download/%2Fpersist/chart.html`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain('filename="chart.html"');
    expect(res.body).toBe("<h1>chart</h1>");
  });

  it("still serves a workspace folder named persist from the workspace", async () => {
    fs.mkdirSync(path.join(workspaceDir, "persist"));
    fs.writeFileSync(path.join(workspaceDir, "persist", "chart.html"), "workspace copy");

    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/files/persist/chart.html`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ content: "workspace copy" });
  });

  it("refuses a /persist symlink that points outside /persist", async () => {
    const secret = path.join(tmpDir, "secret.txt");
    fs.writeFileSync(secret, "do not show");
    fs.symlinkSync(secret, path.join(scratchDir, "link.txt"));

    for (const url of [
      `/api/sessions/${sessionId}/files/%2Fpersist/link.txt`,
      `/api/sessions/${sessionId}/files/download/%2Fpersist/link.txt`,
      `/api/sessions/${sessionId}/docs/%2Fpersist/link.txt`,
    ]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(400);
      expect(res.body, url).not.toContain("do not show");
    }
  });

  it("refuses a /persist path that climbs out of /persist", async () => {
    fs.writeFileSync(path.join(workspaceDir, "inside.txt"), "workspace file");

    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/files/%2Fpersist%2F..%2Fworkspace%2Finside.txt`,
    });
    expect(res.statusCode).toBe(400);
  });
});
