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
  TestClient,
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
  let port: number;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let sessionManager: SessionManager;
  let credentialStore: ReturnType<typeof createTestCredentialStore>;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-spawn-route-"));
    sessionManager = new SessionManager(dbManager);
    credentialStore = createTestCredentialStore(tmpDir);
    app = await buildApp({
      credentialStore,
      credentialsDir: path.join(tmpDir, "credentials"),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      chatHistoryManager: new ChatHistoryManager(dbManager),
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => new FakeClaudeProcess() as never,
      workspaceDir: tmpDir,
      serveStatic: false,
    });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    port = Number(/:(\d+)$/.exec(address)?.[1] ?? 0);
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

  // docs/264-agent-roles req 10 REVERSES docs/261 here: this combination used to be refused
  // at the edge and is now the override path, so it must reach the service (the
  // 404 is the made-up session id, i.e. "the parse let it through").
  it("accepts a role combined with a parameter — the override path", async () => {
    const res = await post({ role: "reviewer", agentId: "codex", prompt: "review", depth: 0 });
    expect(res.statusCode).toBe(404);
    expect(res.json().error as string).toMatch(/session not found/i);
  });

  // req 18 — the name is the user's, so the edge does not judge it. An unknown
  // one is refused by RESOLUTION, which is the only thing that knows the set,
  // and its refusal names it (see the live-session case below).
  it("does not reject an unknown role name at the edge", async () => {
    const res = await post({ role: "critic", prompt: "review", depth: 0 });
    expect(res.statusCode).toBe(404);
    expect(res.json().error as string).toMatch(/session not found/i);
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

  /**
   * The two targets are not interchangeable once they reach the service, and
   * these are the assertions that would fail if the route parsed a target and
   * then ignored it: a **role** goes to the reviewer resolver, which on an
   * install with no credential answers "no reviewer available"; an **explicit**
   * call goes to the named harness's own gates, which answer "not signed in"
   * about that harness. Neither message is reachable from the other path.
   */
  describe("against a live, pinned session", () => {
    let client: TestClient;

    beforeEach(async () => {
      credentialStore.setEnableSubAgents(true);
      client = await TestClient.connect(port);
      await client.receive(); // preview_status
      // A spawn runs on behalf of a PINNED session's agent; pinning normally
      // happens on the first turn, which these tests do not need to run.
      sessionManager.setAgentPinned(client.sessionId);
    });

    afterEach(() => client.close());

    const live = (payload: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: `/api/sessions/${client.sessionId}/agent/spawn`,
        payload,
      });

    it("routes a role to the reviewer resolver", async () => {
      const res = await live({ role: "reviewer", prompt: "review this", depth: 0 });
      expect(res.statusCode).toBe(400);
      // docs/264 — the refusal is now the ROLE's, since every role resolves
      // through one path. The remedy is unchanged.
      expect(res.json().error as string).toMatch(/role "reviewer" cannot run/);
    });

    // req 13 — the refusal is the remedy: it names the roles that DO exist, so an
    // agent that guessed learns what it could have said. On a bare install that
    // is the reviewer, which is always present (req 2).
    it("refuses an unknown role at resolution, listing the roles that exist", async () => {
      const res = await live({ role: "critic", prompt: "review this", depth: 0 });
      expect(res.statusCode).toBe(400);
      const error = res.json().error as string;
      expect(error).toContain("critic");
      expect(error).toContain("reviewer");
    });

    it("routes an explicit call to the named harness's own gates", async () => {
      const res = await live(COMPLETE);
      expect(res.statusCode).toBe(400);
      // The named harness's own gate answers, about the harness the CALL named
      // — not about a reviewer, and not about the session's own agent.
      expect(res.json().error as string).toMatch(/Codex is not signed in/);
    });

    /**
     * docs/264-agent-roles req 12 — the two reads, which ship together. Without them an
     * agent allowed to name a role and override a parameter would be naming both
     * from memory: it cannot see the user's roles (they are settings) and cannot
     * see which models this install holds a credential for.
     */
    it("lists the install's roles, the reviewer included on a bare install", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/sessions/${client.sessionId}/agent/roles`,
      });
      expect(res.statusCode).toBe(200);
      const roles = (res.json() as { roles: { name: string }[] }).roles;
      expect(roles.map((r) => r.name)).toContain("reviewer");
    });

    it("lists the parameters an override may name", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/sessions/${client.sessionId}/agent/params`,
      });
      expect(res.statusCode).toBe(200);
      const harnesses = (res.json() as { harnesses: { id: string; reasoningLevels: string[] }[] })
        .harnesses;
      expect(harnesses.length).toBeGreaterThan(0);
      // Each entry carries the axes `--agent` / `--effort` / the model triple are
      // chosen from; the levels are the harness's own, never a shared list.
      for (const harness of harnesses) {
        expect(typeof harness.id).toBe("string");
        expect(Array.isArray(harness.reasoningLevels)).toBe(true);
      }
    });
  });

  it("404s both reads for a session that does not exist", async () => {
    for (const path of ["roles", "params"]) {
      const res = await app.inject({ method: "GET", url: `/api/sessions/nope/agent/${path}` });
      expect(res.statusCode).toBe(404);
    }
  });
});
