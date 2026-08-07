/**
 * `POST /api/sessions/:id/actions/runs/rerun` — the route behind `gh run rerun`.
 *
 * The service's guardrails are unit-tested in `services/github-rerun-run.test.ts`
 * against a stubbed GitManager. This exercises the parts only a real route can
 * cover: body parsing and coercion refusal, `ServiceError` → status/message
 * propagation, and the guardrails running against a REAL git repo's branch and
 * HEAD rather than a mock's return value — which is what they read in production.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import { GitHubAuthManager } from "../github-auth.js";

import type { FastifyInstance } from "fastify";
import {
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";

const REMOTE = "https://github.com/o/r.git";

/** A stub that records the rerun call and serves whatever run the test sets. */
class ActionsStub extends StubGitHubAuthManager {
  run: Record<string, unknown> | null = null;
  rerunCalls: { runId: number; onlyFailed: boolean }[] = [];
  rerunResult = { ok: true, status: 201, message: "" };

  async listWorkflowRuns(): Promise<unknown[]> {
    return this.run ? [this.run] : [];
  }
  async getWorkflowRun(): Promise<unknown> {
    return this.run;
  }
  async rerunWorkflowRun(
    _owner: string,
    _repo: string,
    runId: number,
    opts: { onlyFailed?: boolean } = {},
  ): Promise<{ ok: boolean; status: number; message: string }> {
    this.rerunCalls.push({ runId, onlyFailed: opts.onlyFailed === true });
    return this.rerunResult;
  }
}

describe("Integration: POST /actions/runs/rerun", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let sessionId: string;
  let dbManager: DatabaseManager;
  let github: ActionsStub;
  let head: string;
  let branch: string;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-rerun-"));

    sessionId = crypto.randomUUID();
    const sessionDir = path.join(tmpDir, "sessions", sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    // Build the repo with raw git rather than `GitManager.init()`: that helper
    // inherits identity from the global config, which isn't guaranteed on a
    // stock CI runner. Repo-local identity + --no-gpg-sign keeps it hermetic.
    const git = new GitManager(sessionDir);
    const run = (...args: string[]) => execFileSync("git", args, { cwd: sessionDir });
    run("init", "--initial-branch=main", "-q");
    run("config", "user.email", "t@t.com");
    run("config", "user.name", "T");
    run("config", "commit.gpgsign", "false");
    run("remote", "add", "origin", REMOTE);
    fs.writeFileSync(path.join(sessionDir, "a.txt"), "hello");
    run("add", "-A");
    run("commit", "-q", "-m", "first");
    head = (await git.getHeadHash()) ?? "";
    branch = (await git.currentBranchOrNull()) ?? "";

    const sessionManager = new SessionManager(dbManager);
    sessionManager.track(sessionId, "Test session", sessionDir);

    github = new ActionsStub();
    await github.setToken("t");

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: github as unknown as GitHubAuthManager,
      agentFactory: () => new FakeClaudeProcess() as any,
      workspaceDir: tmpDir,
      serveStatic: false,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  function makeRun(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      databaseId: 42, number: 1, displayTitle: "CI", workflowName: "CI",
      workflowDatabaseId: 1, headBranch: branch, headSha: head, event: "push",
      status: "completed", conclusion: "failure",
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:01:00Z",
      url: "https://github.com/o/r/actions/runs/42",
      ...over,
    };
  }

  function post(payload: Record<string, unknown>) {
    return app.inject({ method: "POST", url: `/api/sessions/${sessionId}/actions/runs/rerun`, payload });
  }

  it("re-runs the branch's latest run when the body carries no id", async () => {
    github.run = makeRun();
    const res = await post({});
    expect(res.statusCode).toBe(200);
    expect(res.json().run.databaseId).toBe(42);
    expect(github.rerunCalls).toEqual([{ runId: 42, onlyFailed: false }]);
  });

  it("passes failed:true through as onlyFailed", async () => {
    github.run = makeRun();
    const res = await post({ failed: true });
    expect(res.statusCode).toBe(200);
    expect(github.rerunCalls).toEqual([{ runId: 42, onlyFailed: true }]);
  });

  it.each([
    ["1e3"], ["0x2a"], ["1.5"], [" 42"], ["0"], ["-3"], ["9".repeat(30)],
  ])("rejects the coercible id %s with 400 and never calls GitHub", async (id) => {
    github.run = makeRun();
    const res = await post({ id });
    expect(res.statusCode).toBe(400);
    expect(github.rerunCalls).toHaveLength(0);
  });

  it("rejects a non-string id type", async () => {
    github.run = makeRun();
    expect((await post({ id: true })).statusCode).toBe(400);
    expect((await post({ id: [42] })).statusCode).toBe(400);
    expect(github.rerunCalls).toHaveLength(0);
  });

  it("accepts a numeric id as well as its string form", async () => {
    github.run = makeRun();
    expect((await post({ id: 42 })).statusCode).toBe(200);
    expect((await post({ id: "42" })).statusCode).toBe(200);
    expect(github.rerunCalls).toHaveLength(2);
  });

  it("propagates the off-branch refusal as 403 with the reason", async () => {
    // Guardrails read the REAL repo here, so this is the production comparison.
    github.run = makeRun({ headBranch: "stable" });
    const res = await post({ id: "42" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("stable");
    expect(github.rerunCalls).toHaveLength(0);
  });

  it("propagates the wrong-commit refusal as 403", async () => {
    github.run = makeRun({ headSha: "f".repeat(40) });
    const res = await post({ id: "42" });
    expect(res.statusCode).toBe(403);
    expect(github.rerunCalls).toHaveLength(0);
  });

  it("propagates the non-push-event refusal as 403", async () => {
    github.run = makeRun({ event: "workflow_dispatch" });
    const res = await post({ id: "42" });
    expect(res.statusCode).toBe(403);
    expect(github.rerunCalls).toHaveLength(0);
  });

  it("404s when the branch has no runs", async () => {
    github.run = null;
    const res = await post({});
    expect(res.statusCode).toBe(404);
  });

  it("surfaces GitHub's own 403 with the token/run guidance", async () => {
    github.run = makeRun();
    github.rerunResult = { ok: false, status: 403, message: "Resource not accessible by personal access token" };
    const res = await post({});
    expect(res.statusCode).toBe(403);
    const error = res.json().error as string;
    expect(error).toContain("Resource not accessible by personal access token");
    expect(error).toContain("Actions");
  });

  it("401s when GitHub is not connected", async () => {
    github.run = makeRun();
    github.clearCredentials();
    const res = await post({});
    expect(res.statusCode).toBe(401);
  });

  it("404s for an unknown session rather than acting on another one", async () => {
    github.run = makeRun();
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${crypto.randomUUID()}/actions/runs/rerun`,
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(github.rerunCalls).toHaveLength(0);
  });
});
