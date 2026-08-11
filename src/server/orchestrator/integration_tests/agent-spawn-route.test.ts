/**
 * Integration tests for POST /api/sessions/:id/agent/spawn (docs/144, docs/261).
 *
 * The route is the hop between the worker's relay and the spawn service, and
 * docs/261 phase 2 is what it now carries: either a **role** or the five
 * explicit parameters. Two things are worth pinning here rather than only at the
 * service:
 *
 *  - the refusal is the SERVER's, not the shim's. A caller that skips the shim
 *    (or a stale one) must not get an incomplete call quietly completed — that
 *    was the failure mode `SubAgentDefaults` was, and the whole reason req 7
 *    exists.
 *  - the refusal happens at the edge, before any session, runner or credential
 *    is touched, so a malformed call cannot half-run.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import { DatabaseManager } from "../../shared/database.js";

import {
  StubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";

const COMPLETE = {
  agentId: "codex",
  serviceId: "openai",
  billingMode: "sub",
  modelId: "gpt-5.6-sol",
  reasoningEffort: "high",
  prompt: "review this",
  depth: 0,
};

describe("Integration: POST /api/sessions/:id/agent/spawn — the spawn target (docs/261)", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-spawn-route-"));
    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      credentialsDir: path.join(tmpDir, "credentials"),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: new SessionManager(dbManager),
      chatHistoryManager: new ChatHistoryManager(dbManager),
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => new FakeClaudeProcess() as never,
      workspaceDir: tmpDir,
      serveStatic: false,
    });
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors
    }
  });

  const post = (payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/sessions/any-session/agent/spawn", payload });

  it("400 — an incomplete explicit call is refused, naming what is missing", async () => {
    const res = await post({ agentId: "codex", modelId: "gpt-5.6-sol", prompt: "review", depth: 0 });
    expect(res.statusCode).toBe(400);
    const error = res.json().error as string;
    expect(error).toContain("--service");
    expect(error).toContain("--billing-mode");
    expect(error).toContain("--effort");
  });

  it("400 — a role combined with an explicit parameter is refused", async () => {
    const res = await post({ role: "reviewer", agentId: "codex", prompt: "review", depth: 0 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error as string).toContain("--agent");
  });

  it("400 — an unknown role is refused by name", async () => {
    const res = await post({ role: "critic", prompt: "review", depth: 0 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error as string).toContain("critic");
  });

  /**
   * A complete call is ACCEPTED by the parse and reaches the service, which then
   * applies its own gates — the first of which, for this made-up id, is "no such
   * session". The 404 rather than a 400 is the assertion: it says the five
   * parameters got past the edge, which a body-shape regression would break.
   */
  it("passes a complete explicit call through to the service's own gates", async () => {
    const res = await post(COMPLETE);
    expect(res.statusCode).toBe(404);
    expect(res.json().error as string).toMatch(/session not found/i);
  });

  it("passes a role through to the service's own gates", async () => {
    const res = await post({ role: "reviewer", prompt: "review this", depth: 0 });
    expect(res.statusCode).toBe(404);
    expect(res.json().error as string).toMatch(/session not found/i);
  });
});
