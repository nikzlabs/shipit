/**
 * Integration tests for the read-only ShipIt source surface (docs/162).
 *
 * Exercises the orchestrator routes end-to-end against a *real* throwaway git
 * repo wired up as the "running source" via SHIPIT_SOURCE_DIR / SHIPIT_BUILD_ID:
 *
 *   GET /api/sessions/:id/source/status
 *   GET /api/sessions/:id/source/tree
 *   GET /api/sessions/:id/source/search
 *   GET /api/sessions/:id/source/cat
 *
 * Verifies the Ops-only gate (403 for non-ops), redaction (403 on `.env`),
 * and that reads reflect the exact build commit.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { RepoStore } from "../repo-store.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import type { GitHubAuthManager } from "../github-auth.js";
import { DatabaseManager } from "../../shared/database.js";
import {
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";

function git(cwd: string, args: string): void {
  execSync(`git ${args}`, { cwd, stdio: "pipe" });
}

describe("Integration: read-only ShipIt source surface (docs/162)", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let sourceDir: string;
  let sessionManager: SessionManager;
  let dbManager: DatabaseManager;
  let headSha: string;
  const savedEnv = {
    dir: process.env.SHIPIT_SOURCE_DIR,
    buildId: process.env.SHIPIT_BUILD_ID,
    repoUrl: process.env.SHIPIT_SOURCE_REPO_URL,
  };

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-source-"));

    // Build a real git repo to stand in for the deployed ShipIt source.
    sourceDir = path.join(tmpDir, "source");
    fs.mkdirSync(path.join(sourceDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "src", "index.ts"), "export const ContainerSessionRunner = 1;\n");
    fs.writeFileSync(path.join(sourceDir, "src", "util.ts"), "export const x = 2;\n");
    fs.writeFileSync(path.join(sourceDir, ".env"), "SECRET=topsecret\n");
    git(sourceDir, "init -q");
    git(sourceDir, "remote add origin https://github.com/acme/shipit.git");
    git(sourceDir, "add -A");
    git(sourceDir, '-c user.email=t@t.com -c user.name=T commit -q -m init');
    headSha = execSync("git rev-parse HEAD", { cwd: sourceDir, encoding: "utf8" }).trim();

    process.env.SHIPIT_SOURCE_DIR = sourceDir;
    process.env.SHIPIT_BUILD_ID = headSha;
    delete process.env.SHIPIT_SOURCE_REPO_URL;

    sessionManager = new SessionManager(dbManager);
    const repoStore = new RepoStore(dbManager);
    const credentialStore = createTestCredentialStore(tmpDir);

    app = await buildApp({
      credentialStore,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      repoStore,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      agentFactory: () => new FakeClaudeProcess() as never,
      workspaceDir: tmpDir,
      serveStatic: false,
    });
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    process.env.SHIPIT_SOURCE_DIR = savedEnv.dir;
    process.env.SHIPIT_BUILD_ID = savedEnv.buildId;
    process.env.SHIPIT_SOURCE_REPO_URL = savedEnv.repoUrl;
    if (savedEnv.dir === undefined) delete process.env.SHIPIT_SOURCE_DIR;
    if (savedEnv.buildId === undefined) delete process.env.SHIPIT_BUILD_ID;
    if (savedEnv.repoUrl === undefined) delete process.env.SHIPIT_SOURCE_REPO_URL;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // ignore cleanup errors
    }
  });

  async function createSession(kind?: "ops"): Promise<string> {
    const res = await app.inject({ method: "POST", url: "/api/_test/sessions", payload: { title: "S" } });
    expect(res.statusCode).toBe(200);
    const { sessionId } = res.json() as { sessionId: string };
    if (kind === "ops") sessionManager.setKind(sessionId, "ops");
    return sessionId;
  }

  it("status reports the exact build commit for an Ops session", async () => {
    const id = await createSession("ops");
    const res = await app.inject({ method: "GET", url: `/api/sessions/${id}/source/status` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.available).toBe(true);
    expect(body.exact).toBe(true);
    expect(body.ref).toBe(headSha);
    expect(body.refSource).toBe("build-id");
    expect(body.remoteUrl).toBe("https://github.com/acme/shipit.git");
  });

  it("tree lists directory entries at the source ref", async () => {
    const id = await createSession("ops");
    const res = await app.inject({ method: "GET", url: `/api/sessions/${id}/source/tree?path=src` });
    expect(res.statusCode).toBe(200);
    const names = (res.json().entries as { name: string }[]).map((e) => e.name);
    expect(names).toEqual(["index.ts", "util.ts"]);
  });

  it("cat reads a file at the source ref", async () => {
    const id = await createSession("ops");
    const res = await app.inject({ method: "GET", url: `/api/sessions/${id}/source/cat?path=src/index.ts` });
    expect(res.statusCode).toBe(200);
    expect(res.json().content).toContain("ContainerSessionRunner");
  });

  it("cat refuses to read a redacted .env file (403)", async () => {
    const id = await createSession("ops");
    const res = await app.inject({ method: "GET", url: `/api/sessions/${id}/source/cat?path=.env` });
    expect(res.statusCode).toBe(403);
  });

  it("search finds a symbol at the source ref", async () => {
    const id = await createSession("ops");
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${id}/source/search?q=ContainerSessionRunner`,
    });
    expect(res.statusCode).toBe(200);
    const matches = res.json().matches as { path: string }[];
    expect(matches.length).toBe(1);
    expect(matches[0].path).toBe("src/index.ts");
  });

  it("log returns commit history at the source ref", async () => {
    const id = await createSession("ops");
    const res = await app.inject({ method: "GET", url: `/api/sessions/${id}/source/log` });
    expect(res.statusCode).toBe(200);
    const commits = res.json().commits as { hash: string; subject: string }[];
    expect(commits.length).toBeGreaterThanOrEqual(1);
    expect(commits[0].hash).toBe(headSha);
    expect(commits[0].subject).toBe("init");
  });

  it("blame attributes lines to the source ref", async () => {
    const id = await createSession("ops");
    const res = await app.inject({ method: "GET", url: `/api/sessions/${id}/source/blame?path=src/index.ts` });
    expect(res.statusCode).toBe(200);
    const lines = res.json().lines as { line: number; shortHash: string; text: string }[];
    expect(lines[0].line).toBe(1);
    expect(lines[0].shortHash).toBe(headSha.slice(0, 12));
    expect(lines[0].text).toContain("ContainerSessionRunner");
  });

  it("blame refuses a redacted path (403)", async () => {
    const id = await createSession("ops");
    const res = await app.inject({ method: "GET", url: `/api/sessions/${id}/source/blame?path=.env` });
    expect(res.statusCode).toBe(403);
  });

  it("show returns a commit diff with redacted file diffs hidden", async () => {
    const id = await createSession("ops");
    const res = await app.inject({ method: "GET", url: `/api/sessions/${id}/source/show?commit=${headSha}` });
    expect(res.statusCode).toBe(200);
    const content = res.json().content as string;
    // The init commit added src/index.ts AND .env — the source file shows, the
    // secret does not, and the omission is noted.
    expect(content).toContain("src/index.ts");
    expect(content).not.toContain("topsecret");
    expect(content).toMatch(/file diff\(s\) hidden/);
  });

  it("show rejects an invalid commit-ish (400)", async () => {
    const id = await createSession("ops");
    const res = await app.inject({ method: "GET", url: `/api/sessions/${id}/source/show?commit=${encodeURIComponent("--output=/tmp/x")}` });
    expect(res.statusCode).toBe(400);
  });

  it("returns 403 for a non-ops session", async () => {
    const id = await createSession();
    const res = await app.inject({ method: "GET", url: `/api/sessions/${id}/source/status` });
    expect(res.statusCode).toBe(403);
  });

  it("returns 404 for a missing session", async () => {
    const res = await app.inject({ method: "GET", url: `/api/sessions/nope/source/status` });
    expect(res.statusCode).toBe(404);
  });
});
