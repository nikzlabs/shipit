/**
 * docs/201 / SHI-129 — container ↔ browser trust boundary guard.
 *
 * Three concerns:
 *   1. Pure helpers — `isHardDeniedGlobal`, `normalizeRemoteIp`.
 *   2. Guard behavior — a minimal app with a stub IP→session map, driven via
 *      `app.inject({ remoteAddress })` to exercise allow / deny / cross-session /
 *      hard-deny / browser-passthrough / inert-without-containerManager.
 *   3. The GOLDEN route-table contract (the durability mechanism, docs/201 §1):
 *      boot the real app and assert the set of container-reachable routes equals
 *      a committed snapshot. Adding/removing a `containerAccessible` opt-in — or
 *      a route that newly matches — flips this red, forcing a reviewed update.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";

import {
  registerContainerOriginGuard,
  isHardDeniedGlobal,
  normalizeRemoteIp,
} from "./api-container-guard.js";

import { buildApp } from "./index.js";
import { GitManager } from "../shared/git.js";
import { SessionManager } from "./sessions.js";
import { ChatHistoryManager } from "./chat-history.js";
import { AuthManager } from "./agents/claude/auth-manager.js";
import type { DatabaseManager } from "../shared/database.js";
import {
  StubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./integration_tests/test-helpers.js";

// ---------------------------------------------------------------------------
// 1. Pure helpers
// ---------------------------------------------------------------------------

describe("isHardDeniedGlobal", () => {
  it("matches high-value globals exactly and as sub-paths", () => {
    for (const p of [
      "/api/secrets",
      "/api/secrets/some-repo",
      "/api/mcp-servers",
      "/api/mcp-servers/oauth/providers",
      "/api/provider-accounts",
      "/api/trackers/linear/token",
      "/api/updates/check",
    ]) {
      expect(isHardDeniedGlobal(p)).toBe(true);
    }
  });

  it("does not match allowlisted, unrelated, or prefix-lookalike paths", () => {
    for (const p of [
      "/api/sessions/s1/services",
      "/api/bootstrap",
      "/api/repos",
      "/api/secretsfoo", // no path-segment boundary
      "/api/trackersX",
    ]) {
      expect(isHardDeniedGlobal(p)).toBe(false);
    }
  });
});

describe("normalizeRemoteIp", () => {
  it("strips the IPv6-mapped-IPv4 prefix and passes plain IPs through", () => {
    expect(normalizeRemoteIp("::ffff:172.18.0.5")).toBe("172.18.0.5");
    expect(normalizeRemoteIp("172.18.0.5")).toBe("172.18.0.5");
  });
  it("returns null for a missing address", () => {
    expect(normalizeRemoteIp(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Guard behavior (minimal app + stub IP→session map)
// ---------------------------------------------------------------------------

const CONTAINER_IP = "172.18.0.5";
const BROWSER_IP = "10.0.0.9";
const OWN_SESSION = "sess-own";

describe("registerContainerOriginGuard — request gating", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    registerContainerOriginGuard(app, {
      containerManager: {
        getSessionByContainerIp: (ip: string) =>
          ip === CONTAINER_IP ? { sessionId: OWN_SESSION } : undefined,
      },
    });
    // An allowlisted own-session route, a browser-only route, and a hard-denied
    // global that has been (incorrectly) flagged — to prove hard-deny wins.
    app.get<{ Params: { id: string } }>(
      "/api/sessions/:id/services",
      { config: { containerAccessible: true } },
      async () => ({ ok: true }),
    );
    app.get("/api/bootstrap", async () => ({ ok: true }));
    app.put("/api/secrets", { config: { containerAccessible: true } }, async () => ({ ok: true }));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("allows a container to reach an allowlisted route for its OWN session", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${OWN_SESSION}/services`,
      remoteAddress: CONTAINER_IP,
    });
    expect(res.statusCode).toBe(200);
  });

  it("normalizes ::ffff: IPv6-mapped source IPs", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${OWN_SESSION}/services`,
      remoteAddress: `::ffff:${CONTAINER_IP}`,
    });
    expect(res.statusCode).toBe(200);
  });

  it("denies a container reaching an allowlisted route for ANOTHER session", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-other/services",
      remoteAddress: CONTAINER_IP,
    });
    expect(res.statusCode).toBe(403);
  });

  it("denies a container reaching a non-allowlisted (unflagged) route", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
      remoteAddress: CONTAINER_IP,
    });
    expect(res.statusCode).toBe(403);
  });

  it("hard-denies a high-value global even when mistakenly flagged", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/secrets",
      remoteAddress: CONTAINER_IP,
    });
    expect(res.statusCode).toBe(403);
  });

  it("lets a NON-container (browser) origin reach everything, including globals", async () => {
    const secrets = await app.inject({ method: "PUT", url: "/api/secrets", remoteAddress: BROWSER_IP });
    expect(secrets.statusCode).toBe(200);
    const bootstrap = await app.inject({ method: "GET", url: "/api/bootstrap", remoteAddress: BROWSER_IP });
    expect(bootstrap.statusCode).toBe(200);
  });
});

describe("registerContainerOriginGuard — inert without a containerManager", () => {
  it("does not gate any origin when no IP→session map is provided", async () => {
    const app = Fastify({ logger: false });
    registerContainerOriginGuard(app, {});
    app.get("/api/bootstrap", async () => ({ ok: true }));
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/bootstrap", remoteAddress: CONTAINER_IP });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// 3. GOLDEN route-table contract (docs/201 §1)
// ---------------------------------------------------------------------------

/**
 * The COMPLETE set of orchestrator routes a session container may reach, scoped
 * to its own session. Derived from the worker's `OrchestratorClient` broker
 * targets (`agent-ops-routes.ts`) plus the two documented direct curls
 * (services, service logs). Changing this list is a deliberate security
 * decision — update it ONLY alongside a corresponding `containerAccessible`
 * change, and review why a container now needs the route.
 */
const GOLDEN_CONTAINER_ROUTES = [
  // preview — documented direct curls
  "GET /api/sessions/:id/services",
  "GET /api/sessions/:id/services/:name/logs",
  // github — gh shim + git credential helper
  "GET /api/sessions/:id/pr/status",
  "POST /api/sessions/:id/pr/agent-create",
  "POST /api/sessions/:id/git/credential",
  "PATCH /api/sessions/:id/pr/:number",
  "GET /api/sessions/:id/pr/list",
  "GET /api/sessions/:id/pr/view",
  "POST /api/sessions/:id/pr/:number/comment",
  "POST /api/sessions/:id/pr/:number/ready",
  "POST /api/sessions/:id/pr/:number/close",
  "POST /api/sessions/:id/pr/:number/reopen",
  // issues — shipit issue
  "GET /api/sessions/:id/issue/view",
  "GET /api/sessions/:id/issue/list",
  "GET /api/sessions/:id/issue/comments",
  "POST /api/sessions/:sessionId/issue/create",
  "POST /api/sessions/:sessionId/issue/comment",
  "POST /api/sessions/:sessionId/issue/edit",
  "POST /api/sessions/:sessionId/issue/status",
  "POST /api/sessions/:sessionId/issue/assign",
  // source — shipit source (ops sessions)
  "GET /api/sessions/:id/source/status",
  "GET /api/sessions/:id/source/tree",
  "GET /api/sessions/:id/source/search",
  "GET /api/sessions/:id/source/cat",
  "GET /api/sessions/:id/source/log",
  "GET /api/sessions/:id/source/blame",
  "GET /api/sessions/:id/source/show",
  // agent — shipit agent run
  "POST /api/sessions/:id/agent/spawn",
  // session — shipit session create/list/view/wait/message/archive + notify-on-merge
  "POST /api/sessions/:parentId/spawn",
  "GET /api/sessions/:parentId/children",
  "GET /api/sessions/:parentId/children/:childId",
  "POST /api/sessions/:parentId/children/:childId/message",
  "POST /api/sessions/:parentId/children/:childId/archive",
  "POST /api/sessions/:parentId/children/:childId/notify-on-merge",
  // bridges — voice_note / report_shipit_bug / submit_review
  "POST /api/sessions/:sessionId/voice-note",
  "POST /api/sessions/:sessionId/bug-report",
  "POST /api/sessions/:sessionId/review-submit",
].sort();

describe("GOLDEN container-reachable route table", () => {
  let app: FastifyInstance;
  let dbManager: DatabaseManager;
  let tmpDir: string;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-guard-"));
    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: new SessionManager(dbManager),
      chatHistoryManager: new ChatHistoryManager(dbManager),
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => new FakeClaudeProcess() as any,
      // NOTE: review-submit lives in the review module, which `buildApp`
      // registers unconditionally (it constructs its own FileReviewStore via
      // app-di). If a future container-facing route lands in a module gated on
      // an injectable store (e.g. secrets/marketplace), wire that store into
      // this buildApp call or the snapshot will silently under-count.
      workspaceDir: tmpDir,
      serveStatic: false,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // ignore cleanup errors
    }
  });

  it("matches the committed snapshot exactly", () => {
    const actual = [...app.containerAccessibleRoutes].sort();
    expect(actual).toEqual(GOLDEN_CONTAINER_ROUTES);
  });
});
