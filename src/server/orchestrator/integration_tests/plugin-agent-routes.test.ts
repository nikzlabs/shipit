/**
 * docs/262 reqs 12, 17 — the agent's two plugin verbs are actually WIRED.
 *
 * Both hooks are produced by `bootstrapManagers` and consumed by
 * `api-routes-plugin-repos.ts`, and for as long as they existed nothing carried
 * them across `route-registry.ts` — which type-checked, because `ApiDeps`
 * declared them optional. So `POST …/plugin/refresh` answered
 * `501 This runtime cannot refresh plugin repositories.` on every deployment,
 * production included, while every co-located test passed: each injects the
 * hook directly and therefore cannot see the gap between "the route works" and
 * "the app hands the route anything to work with".
 *
 * This is the missing half — a route reached through the REAL registration
 * path. It deliberately asserts the negative (`not 501`) rather than a refresh
 * result: what broke was the wiring, and a refresh over a workspace that
 * declares no plugins is the cheapest way to prove the hook arrived.
 *
 * **What each case can and cannot prove, because the two verbs differ here**
 * (review finding). Refresh is produced unconditionally, so its arrival is
 * observable and is what the first test asserts. The exec hook is legitimately
 * `undefined` in a runtime with no Docker — which this one is — so no assertion
 * at this level can tell "forwarded, and absent for the right reason" from
 * "not forwarded". What guards THAT half is the type: `ApiDeps` declares both
 * keys required with a `| undefined` value, so dropping the forward is a build
 * error. The exec test below therefore asserts the honest-answer shape, not the
 * wiring.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import { DatabaseManager } from "../../shared/database.js";
import {
  StubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";

describe("Integration: the agent's plugin routes", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let sessionId: string;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-plugin-routes-"));

    sessionId = crypto.randomUUID();
    // `<sessionDir>/workspace` is load-bearing: the plugin state dir resolves
    // off the session root, and a clone anywhere else is refused (planning#288).
    const sessionDir = path.join(tmpDir, "sessions", sessionId, "workspace");
    fs.mkdirSync(sessionDir, { recursive: true });
    // No `plugins:` block: the subject is the wiring, not the activation.
    fs.writeFileSync(path.join(sessionDir, "shipit.yaml"), "agent:\n  install: npm ci\n");

    const sessionManager = new SessionManager(dbManager);
    sessionManager.track(sessionId, "Plugin routes", sessionDir);

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => new FakeClaudeProcess() as never,
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
    } catch { /* best effort */ }
  });

  it("hands the refresh route a refresh hook (req 12)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/plugin/refresh`,
      payload: {},
    });

    // 501 here means the hook never crossed `route-registry.ts` — the exact
    // failure this file exists for. Any other answer means the route ran.
    expect(res.statusCode, res.body).not.toBe(501);
    expect(res.json()).toMatchObject({ rows: [] });
  });

  it("answers the exec route honestly where there is no container runtime (req 17)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/plugin/exec`,
      payload: { alias: "probe", command: "probe" },
    });

    // The exec hook is legitimately absent without Docker (plan §1b — running a
    // companion CLI anywhere else is what the design refuses), so 501 is the
    // right answer. What is asserted is the REASON: the runtime message, not a
    // 404 or a guard rejection, is what tells a reader the route is reachable
    // and the hook is the thing missing.
    expect(res.statusCode).toBe(501);
    expect(res.json()).toMatchObject({
      error: "This runtime cannot run plugin commands (it has no container runtime).",
    });
  });

  it("answers 404 from the handler, not from an unregistered route", async () => {
    const missing = crypto.randomUUID();
    for (const verb of ["refresh", "exec"]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${missing}/plugin/${verb}`,
        payload: { alias: "probe", command: "probe" },
      });
      expect(res.statusCode, verb).toBe(404);
      // The BODY, because 404 is also what Fastify answers for a route that was
      // never registered at all — so status alone would pass in exactly the
      // world this file exists to rule out (review finding).
      expect(res.json(), verb).toMatchObject({ error: "Session not found" });
    }
  });
});
