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

describe("Integration: Features", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-features-"));

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
      // Ignore cleanup errors
    }
  });

  it("list_features returns empty array when no docs/ directory", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // initial preview_status

    client.send({ type: "list_features" });
    const msg = await client.receiveSkipLogs();

    expect(msg.type).toBe("feature_list");
    expect((msg as any).features).toEqual([]);

    client.close();
  });

  it("list_features returns features from docs/ directory", async () => {
    // Create a feature directory with plan.md
    const featureDir = path.join(tmpDir, "docs", "001-my-feature");
    fs.mkdirSync(featureDir, { recursive: true });
    fs.writeFileSync(
      path.join(featureDir, "plan.md"),
      "---\nstatus: in-progress\n---\n# My Feature\n\nDescription.",
    );

    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "list_features" });
    const msg = await client.receiveSkipLogs();

    expect(msg.type).toBe("feature_list");
    const features = (msg as any).features;
    expect(features).toHaveLength(1);
    expect(features[0]).toMatchObject({
      id: "001-my-feature",
      number: 1,
      name: "My Feature",
      status: "in-progress",
      planPath: "docs/001-my-feature/plan.md",
    });

    client.close();
  });

  it("list_features includes checklistPath when checklist.md exists", async () => {
    const featureDir = path.join(tmpDir, "docs", "002-another");
    fs.mkdirSync(featureDir, { recursive: true });
    fs.writeFileSync(path.join(featureDir, "plan.md"), "# Another Feature");
    fs.writeFileSync(path.join(featureDir, "checklist.md"), "- [ ] Do something");

    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "list_features" });
    const msg = await client.receiveSkipLogs();

    expect(msg.type).toBe("feature_list");
    const features = (msg as any).features;
    expect(features[0]).toMatchObject({
      id: "002-another",
      checklistPath: "docs/002-another/checklist.md",
    });

    client.close();
  });

  it("list_features sorts by feature number", async () => {
    for (const name of ["010-deploy", "002-git", "005-ux"]) {
      const dir = path.join(tmpDir, "docs", name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "plan.md"), `# ${name}`);
    }

    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "list_features" });
    const msg = await client.receiveSkipLogs();

    expect(msg.type).toBe("feature_list");
    const numbers = (msg as any).features.map((f: any) => f.number);
    expect(numbers).toEqual([2, 5, 10]);

    client.close();
  });

  it("list_features defaults to 'planned' when no frontmatter", async () => {
    const featureDir = path.join(tmpDir, "docs", "001-basic");
    fs.mkdirSync(featureDir, { recursive: true });
    fs.writeFileSync(path.join(featureDir, "plan.md"), "# Basic Feature\n\nNo frontmatter.");

    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "list_features" });
    const msg = await client.receiveSkipLogs();

    expect(msg.type).toBe("feature_list");
    expect((msg as any).features[0].status).toBe("planned");

    client.close();
  });
});
