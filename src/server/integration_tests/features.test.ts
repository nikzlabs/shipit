import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../auth.js";
import { PreviewManager } from "../preview-manager.js";
import { ClaudeProcess } from "../claude.js";
import { FileWatcher } from "../file-watcher.js";
import type { FastifyInstance } from "fastify";
import {
  StubPreviewManager,
  StubAuthManager,
  FakeClaudeProcess,
  StubFileWatcher,
} from "./test-helpers.js";

describe("Integration: Features", () => {
  let app: FastifyInstance;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-features-"));

    const sessionsFile = path.join(tmpDir, "sessions.json");
    const sessionManager = new SessionManager(sessionsFile);

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

  it("returns empty array when no docs/ directory", async () => {
    const res = await app.inject({ method: "GET", url: "/api/features" });
    expect(res.statusCode).toBe(200);
    expect(res.json().features).toEqual([]);
  });

  it("returns features from docs/ directory", async () => {
    const featureDir = path.join(tmpDir, "docs", "001-my-feature");
    fs.mkdirSync(featureDir, { recursive: true });
    fs.writeFileSync(
      path.join(featureDir, "plan.md"),
      "---\nstatus: in-progress\n---\n# My Feature\n\nDescription.",
    );

    const res = await app.inject({ method: "GET", url: "/api/features" });
    expect(res.statusCode).toBe(200);
    const features = res.json().features;
    expect(features).toHaveLength(1);
    expect(features[0]).toMatchObject({
      id: "001-my-feature",
      number: 1,
      name: "My Feature",
      status: "in-progress",
      planPath: "docs/001-my-feature/plan.md",
    });
  });

  it("includes checklistPath when checklist.md exists", async () => {
    const featureDir = path.join(tmpDir, "docs", "002-another");
    fs.mkdirSync(featureDir, { recursive: true });
    fs.writeFileSync(path.join(featureDir, "plan.md"), "# Another Feature");
    fs.writeFileSync(path.join(featureDir, "checklist.md"), "- [ ] Do something");

    const res = await app.inject({ method: "GET", url: "/api/features" });
    expect(res.statusCode).toBe(200);
    const features = res.json().features;
    expect(features[0]).toMatchObject({
      id: "002-another",
      checklistPath: "docs/002-another/checklist.md",
    });
  });

  it("sorts by feature number", async () => {
    for (const name of ["010-deploy", "002-git", "005-ux"]) {
      const dir = path.join(tmpDir, "docs", name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "plan.md"), `# ${name}`);
    }

    const res = await app.inject({ method: "GET", url: "/api/features" });
    expect(res.statusCode).toBe(200);
    const numbers = res.json().features.map((f: any) => f.number);
    expect(numbers).toEqual([2, 5, 10]);
  });

  it("defaults to 'planned' when no frontmatter", async () => {
    const featureDir = path.join(tmpDir, "docs", "001-basic");
    fs.mkdirSync(featureDir, { recursive: true });
    fs.writeFileSync(path.join(featureDir, "plan.md"), "# Basic Feature\n\nNo frontmatter.");

    const res = await app.inject({ method: "GET", url: "/api/features" });
    expect(res.statusCode).toBe(200);
    expect(res.json().features[0].status).toBe("planned");
  });
});
