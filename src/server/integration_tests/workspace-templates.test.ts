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

describe("Integration: Workspace project templates", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let lastClaude: FakeClaudeProcess = null as any;

  beforeEach(async () => {
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-templates-"));

    const sessionsFile = path.join(tmpDir, "sessions.json");
    sessionManager = new SessionManager(sessionsFile);

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      viteManager: new StubViteManager() as unknown as ViteManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
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
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("list_templates returns all available templates", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "list_templates" });
    const msg = await client.receive();

    expect(msg.type).toBe("template_list");
    const templates = (msg as any).templates;
    expect(templates.length).toBeGreaterThanOrEqual(12);
    expect(templates[0]).toHaveProperty("id");
    expect(templates[0]).toHaveProperty("name");
    expect(templates[0]).toHaveProperty("description");
    expect(templates[0]).toHaveProperty("category");
    expect(templates[0]).not.toHaveProperty("files");

    client.close();
  });

  it("apply_template scaffolds files and returns template_applied", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "apply_template", templateId: "react-vite-ts" });
    // Session isolation: apply_template creates a session, sending session_started first
    const sessionMsg = await client.receive();
    expect(sessionMsg.type).toBe("session_started");
    const sessionDir = (sessionMsg as any).session.workspaceDir;
    expect(sessionDir).toBeTruthy();

    const msg = await client.receive();
    expect(msg.type).toBe("template_applied");
    expect((msg as any).templateId).toBe("react-vite-ts");
    expect((msg as any).name).toBe("React + Vite");

    // Verify files were written to the session's workspace directory
    expect(fs.existsSync(path.join(sessionDir, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "src/App.tsx"))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "index.html"))).toBe(true);

    // Verify git committed the files in the session's repo
    const sessionGit = new GitManager(sessionDir);
    const log = await sessionGit.log();
    const templateCommit = log.find((c) => c.message.includes("Apply template"));
    expect(templateCommit).toBeDefined();

    client.close();
  });

  it("apply_template returns error for unknown template ID", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "apply_template", templateId: "does-not-exist" });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toContain("Unknown template");

    client.close();
  });

  it("apply_template returns error for empty template ID", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "apply_template", templateId: "" } as any);
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toContain("Template ID is required");

    client.close();
  });

  it("apply_template works for static-html template (no package.json)", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "apply_template", templateId: "static-html" });
    // Consume session_started (session isolation creates a session first)
    const sessionMsg = await client.receive();
    expect(sessionMsg.type).toBe("session_started");
    const sessionDir = (sessionMsg as any).session.workspaceDir;

    const msg = await client.receive();
    expect(msg.type).toBe("template_applied");
    expect((msg as any).templateId).toBe("static-html");

    expect(fs.existsSync(path.join(sessionDir, "index.html"))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "style.css"))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "main.js"))).toBe(true);
    // static-html has no package.json
    expect(fs.existsSync(path.join(sessionDir, "package.json"))).toBe(false);

    client.close();
  });

  it("apply_template works for nextjs template with nested directories", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "apply_template", templateId: "nextjs" });
    // Consume session_started (session isolation creates a session first)
    const sessionMsg = await client.receive();
    expect(sessionMsg.type).toBe("session_started");
    const sessionDir = (sessionMsg as any).session.workspaceDir;

    const msg = await client.receive();
    expect(msg.type).toBe("template_applied");
    expect(fs.existsSync(path.join(sessionDir, "src/app/layout.tsx"))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "src/app/page.tsx"))).toBe(true);

    client.close();
  });
});
