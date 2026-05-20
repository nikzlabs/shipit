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
import type { SkillInfo } from "../../shared/types.js";

describe("Integration: Skills", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let sessionId: string;
  let sessionDir: string;
  let dbManager: DatabaseManager;

  function writeClaudeSkill(name: string, frontmatter: string) {
    const dir = path.join(sessionDir, ".claude", "skills", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n# body\n`);
  }

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-skills-"));

    sessionId = crypto.randomUUID();
    sessionDir = path.join(tmpDir, "sessions", sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    const sessionManager = new SessionManager(dbManager);
    sessionManager.track(sessionId, "Test session", sessionDir);

    const credentialStore = createTestCredentialStore(tmpDir);

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

  it("returns an empty list when the workspace has no skills", async () => {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/skills` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { skills: SkillInfo[] }).skills).toEqual([]);
  });

  it("lists user-invocable Claude project skills sorted by name", async () => {
    writeClaudeSkill("zebra", `name: zebra\ndescription: Last one`);
    writeClaudeSkill("alpha", `name: alpha\ndescription: "First one"`);
    writeClaudeSkill("hidden", `name: hidden\nuser-invocable: false`);

    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/skills` });
    expect(res.statusCode).toBe(200);
    const { skills } = res.json() as { skills: SkillInfo[] };
    expect(skills).toEqual([
      { name: "alpha", description: "First one", source: "project" },
      { name: "zebra", description: "Last one", source: "project" },
    ]);
  });

  it("honors ?agent=codex by scanning .codex/skills", async () => {
    writeClaudeSkill("claude-only", `name: claude-only`);
    const shipDir = path.join(sessionDir, ".codex", "skills", "ship");
    fs.mkdirSync(shipDir, { recursive: true });
    fs.writeFileSync(path.join(shipDir, "SKILL.md"), "body");

    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/skills?agent=codex`,
    });
    expect(res.statusCode).toBe(200);
    const { skills } = res.json() as { skills: SkillInfo[] };
    expect(skills.map((s) => s.name)).toEqual(["ship"]);
  });

  it("returns 404 for an unknown session", async () => {
    const res = await app.inject({ method: "GET", url: `/api/sessions/does-not-exist/skills` });
    expect(res.statusCode).toBe(404);
  });
});
