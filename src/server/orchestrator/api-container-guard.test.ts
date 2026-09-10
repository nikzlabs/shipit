import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";

import {
  registerContainerOriginGuard,
  isHardDeniedGlobal,
  normalizeRemoteIp,
  registerUntrustedContainerNetwork,
  clearUntrustedContainerNetworks,
  isUntrustedContainerIp,
} from "./api-container-guard.js";
import {
  EGRESS_DECISION_HEADER,
  mintEgressDecisionToken,
  clearAllEgressDecisionTokens,
} from "./egress-decision-auth.js";

import { buildApp } from "./index.js";
import { SessionContainerManager } from "./session-container.js";
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
      "/api/secretsfoo",
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

const CONTAINER_IP = "172.18.0.5";
const SERVICE_IP = "172.18.0.6";
const BROWSER_IP = "10.0.0.9";
const OWN_SESSION = "98f05156-7e64-422d-81bc-ba677fda60e0";

describe("registerContainerOriginGuard — request gating", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    registerContainerOriginGuard(app, {
      containerManager: {
        getSessionByContainerIp: (ip: string) =>
          ip === CONTAINER_IP ? { sessionId: OWN_SESSION } : undefined,
        getSessionByAnyContainerIp: async (ip: string) =>
          ip === SERVICE_IP ? { sessionId: OWN_SESSION } : undefined,
      },
    });
    app.get<{ Params: { id: string } }>(
      "/api/sessions/:id/services",
      { config: { containerAccessible: true } },
      async () => ({ ok: true }),
    );
    app.get("/api/bootstrap", async () => ({ ok: true }));
    app.put("/api/secrets", { config: { containerAccessible: true } }, async () => ({ ok: true }));
    app.get("/api/egress/decision", { config: { containerAccessible: true } }, async () => ({ allow: false }));
    app.get<{ Params: { id: string } }>(
      "/api/sessions/:id/host-sessions",
      { config: { containerAccessible: true } },
      async () => ({ sessions: [] }),
    );
    app.get<{ Params: { id: string } }>(
      "/api/sessions/:id/host-session-logs",
      { config: { containerAccessible: true } },
      async () => ({ entries: [] }),
    );
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    clearAllEgressDecisionTokens();
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

  it("denies a Compose service IP the whole API, including its own session's routes", async () => {
    const global = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
      remoteAddress: SERVICE_IP,
    });
    expect(global.statusCode).toBe(403);
    const own = await app.inject({
      method: "GET",
      url: `/api/sessions/${OWN_SESSION}/services`,
      remoteAddress: SERVICE_IP,
    });
    expect(own.statusCode).toBe(403);
  });

  it("denies a Compose service the egress decision query with no token", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/egress/decision?host=example.com&session=${OWN_SESSION}`,
      remoteAddress: SERVICE_IP,
    });
    expect(res.statusCode).toBe(403);
  });

  it("admits the egress decision query from a service netns with its sidecar's token", async () => {
    const token = mintEgressDecisionToken(OWN_SESSION);
    const res = await app.inject({
      method: "GET",
      url: `/api/egress/decision?host=example.com&session=${OWN_SESSION}`,
      headers: { [EGRESS_DECISION_HEADER]: token },
      remoteAddress: SERVICE_IP,
    });
    expect(res.statusCode).toBe(200);
  });

  it("refuses a sidecar token minted for a DIFFERENT session", async () => {
    const token = mintEgressDecisionToken("sess-other");
    const res = await app.inject({
      method: "GET",
      url: `/api/egress/decision?host=example.com&session=${OWN_SESSION}`,
      headers: { [EGRESS_DECISION_HEADER]: token },
      remoteAddress: SERVICE_IP,
    });
    expect(res.statusCode).toBe(403);
  });

  it("refuses a valid token presented for a route other than the decision query", async () => {
    const token = mintEgressDecisionToken(OWN_SESSION);
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${OWN_SESSION}/services`,
      headers: { [EGRESS_DECISION_HEADER]: token },
      remoteAddress: SERVICE_IP,
    });
    expect(res.statusCode).toBe(403);
  });

  it("refuses a valid token whose ?session= names another session", async () => {
    const token = mintEgressDecisionToken(OWN_SESSION);
    const res = await app.inject({
      method: "GET",
      url: "/api/egress/decision?host=example.com&session=sess-other",
      headers: { [EGRESS_DECISION_HEADER]: token },
      remoteAddress: SERVICE_IP,
    });
    expect(res.statusCode).toBe(403);
  });

  it("leaves same-session preview traffic from a service alone", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
      headers: { host: `${OWN_SESSION}--5173.localhost` },
      remoteAddress: SERVICE_IP,
    });
    expect(res.statusCode).toBe(200);
  });

  it("does not bypass the guard for an invalid preview port", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
      headers: { host: `${OWN_SESSION}--99999.localhost` },
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

  it("allows a query-scoped route (?session=own) for the caller's OWN session", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/egress/decision?host=example.com&session=${OWN_SESSION}`,
      remoteAddress: CONTAINER_IP,
    });
    expect(res.statusCode).toBe(200);
  });

  it("denies a query-scoped route when ?session= names ANOTHER session", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/egress/decision?host=example.com&session=sess-other",
      remoteAddress: CONTAINER_IP,
    });
    expect(res.statusCode).toBe(403);
  });

  it("denies a query-scoped route when ?session= is absent", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/egress/decision?host=example.com",
      remoteAddress: CONTAINER_IP,
    });
    expect(res.statusCode).toBe(403);
  });

  it("scopes the ops inventory route on the PATH, not on its ?id= filter (docs/255)", async () => {
    const own = await app.inject({
      method: "GET",
      url: `/api/sessions/${OWN_SESSION}/host-sessions?id=sess-other`,
      remoteAddress: CONTAINER_IP,
    });
    expect(own.statusCode).toBe(200);
    const other = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-other/host-sessions",
      remoteAddress: CONTAINER_IP,
    });
    expect(other.statusCode).toBe(403);
  });

  it("scopes the ops log route on the PATH, not on its ?target= filter (docs/264)", async () => {
    const own = await app.inject({
      method: "GET",
      url: `/api/sessions/${OWN_SESSION}/host-session-logs?target=sess-other`,
      remoteAddress: CONTAINER_IP,
    });
    expect(own.statusCode).toBe(200);
    const other = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-other/host-session-logs",
      remoteAddress: CONTAINER_IP,
    });
    expect(other.statusCode).toBe(403);
  });

  it("lets a NON-container (browser) origin reach everything, including globals", async () => {
    const secrets = await app.inject({ method: "PUT", url: "/api/secrets", remoteAddress: BROWSER_IP });
    expect(secrets.statusCode).toBe(200);
    const bootstrap = await app.inject({ method: "GET", url: "/api/bootstrap", remoteAddress: BROWSER_IP });
    expect(bootstrap.statusCode).toBe(200);
  });
});

describe("registerContainerOriginGuard — cost of the hook", () => {
  const OPS_SERVICE_IP = "172.31.0.7";
  let app: FastifyInstance;
  let manager: SessionContainerManager;
  let listContainers: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    listContainers = vi.fn(async () => [{
      Id: "svc",
      Labels: { "shipit-parent-session": OWN_SESSION },
      NetworkSettings: { Networks: { net: { IPAddress: OPS_SERVICE_IP } } },
    }]);
    manager = new SessionContainerManager({
      docker: {
        listContainers,
        getNetwork: () => ({ inspect: async () => { throw new Error("no such network"); } }),
      } as never,
      imageName: "shipit-session-worker:test",
      networkName: "shipit-test",
      skipHealthCheck: true,
    });

    app = Fastify({ logger: false });
    registerContainerOriginGuard(app, { containerManager: manager });
    app.get("/api/bootstrap", async () => ({ ok: true }));
    app.put("/api/secrets", async () => ({ ok: true }));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await manager.dispose();
    clearUntrustedContainerNetworks();
  });

  it("stops querying Docker for a browser source IP", async () => {
    const first = await app.inject({ method: "GET", url: "/api/bootstrap", remoteAddress: BROWSER_IP });
    expect(first.statusCode).toBe(200);
    const afterFirst = listContainers.mock.calls.length;

    for (let i = 0; i < 20; i++) {
      const res = await app.inject({ method: "GET", url: "/api/bootstrap", remoteAddress: BROWSER_IP });
      expect(res.statusCode).toBe(200);
    }
    expect(listContainers.mock.calls.length).toBe(afterFirst);

    // Cross the old one-second negative-cache window to detect repeated Docker queries.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const later = await app.inject({ method: "GET", url: "/api/bootstrap", remoteAddress: BROWSER_IP });
    expect(later.statusCode).toBe(200);
    expect(listContainers.mock.calls.length).toBe(afterFirst);
  });

  it("still denies the Compose service IP the API it resolves through that index", async () => {
    for (const url of ["/api/bootstrap", "/api/secrets"]) {
      const res = await app.inject({ method: "GET", url, remoteAddress: OPS_SERVICE_IP });
      expect(res.statusCode).toBe(403);
    }
    const repeat = await app.inject({ method: "GET", url: "/api/bootstrap", remoteAddress: OPS_SERVICE_IP });
    expect(repeat.statusCode).toBe(403);
  });

  it("keeps the §0 untrusted-network deny ahead of the lookup entirely", async () => {
    registerUntrustedContainerNetwork("172.28.0.0/16");
    listContainers.mockClear();

    const res = await app.inject({ method: "GET", url: "/api/bootstrap", remoteAddress: "172.28.0.7" });

    expect(res.statusCode).toBe(403);
    expect(listContainers).not.toHaveBeenCalled();
  });
});

describe("untrusted container networks", () => {
  afterEach(() => {
    clearUntrustedContainerNetworks();
  });

  it("matches addresses inside a registered CIDR and nothing else", () => {
    expect(registerUntrustedContainerNetwork("172.28.0.0/16")).toBe(true);
    expect(isUntrustedContainerIp("172.28.0.1")).toBe(true);
    expect(isUntrustedContainerIp("172.28.255.254")).toBe(true);
    expect(isUntrustedContainerIp("172.29.0.1")).toBe(false);
    expect(isUntrustedContainerIp(CONTAINER_IP)).toBe(false);
    expect(isUntrustedContainerIp("not-an-ip")).toBe(false);
  });

  it("refuses a CIDR it cannot match, rather than registering a no-op", () => {
    expect(registerUntrustedContainerNetwork("fd00::/64")).toBe(false);
    expect(registerUntrustedContainerNetwork("172.28.0.0/33")).toBe(false);
    expect(registerUntrustedContainerNetwork("nonsense")).toBe(false);
  });

  it("denies the whole API — including routes a session container may reach", async () => {
    registerUntrustedContainerNetwork("172.28.0.0/16");
    const app = Fastify({ logger: false });
    registerContainerOriginGuard(app, {
      containerManager: {
        getSessionByContainerIp: (ip: string) =>
          ip === CONTAINER_IP ? { sessionId: OWN_SESSION } : undefined,
      },
    });
    app.get<{ Params: { id: string } }>(
      "/api/sessions/:id/git/credential",
      { config: { containerAccessible: true } },
      async () => ({ username: "x", password: "secret" }),
    );
    app.get("/api/bootstrap", async () => ({ ok: true }));
    await app.ready();

    for (const url of [`/api/sessions/${OWN_SESSION}/git/credential`, "/api/bootstrap"]) {
      const res = await app.inject({ method: "GET", url, remoteAddress: "172.28.0.7" });
      expect(res.statusCode).toBe(403);
    }
    expect((await app.inject({ method: "GET", url: "/api/bootstrap", remoteAddress: BROWSER_IP })).statusCode).toBe(200);
    await app.close();
  });

  it("denies even where the guard is otherwise inert (no IP→session map)", async () => {
    registerUntrustedContainerNetwork("172.28.0.0/16");
    const app = Fastify({ logger: false });
    registerContainerOriginGuard(app, {});
    app.get("/api/bootstrap", async () => ({ ok: true }));
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/bootstrap", remoteAddress: "172.28.0.7" });
    expect(res.statusCode).toBe(403);
    await app.close();
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

const GOLDEN_CONTAINER_ROUTES = [
  "GET /api/sessions/:id/services",
  "GET /api/sessions/:id/services/:name/logs",
  "GET /api/sessions/:id/pr/status",
  "POST /api/sessions/:id/pr/agent-create",
  "POST /api/sessions/:id/git/credential",
  "POST /api/sessions/:id/plugin/refresh",
  "POST /api/sessions/:id/plugin/exec",
  "GET /api/sessions/:id/plugin/status",
  "PATCH /api/sessions/:id/pr/:number",
  "GET /api/sessions/:id/pr/list",
  "GET /api/sessions/:id/pr/view",
  "POST /api/sessions/:id/pr/:number/comment",
  "POST /api/sessions/:id/pr/:number/ready",
  "POST /api/sessions/:id/pr/:number/close",
  "POST /api/sessions/:id/pr/:number/reopen",
  "POST /api/sessions/:id/pr/:number/merge",
  "GET /api/sessions/:id/actions/runs",
  "GET /api/sessions/:id/actions/runs/view",
  "GET /api/sessions/:id/actions/workflows",
  "GET /api/sessions/:id/actions/workflows/view",
  "POST /api/sessions/:id/actions/runs/rerun",
  "POST /api/sessions/:id/release/plan",
  "POST /api/sessions/:id/release/prepare",
  "POST /api/sessions/:id/rename",
  "GET /api/sessions/:id/issue/view",
  "GET /api/sessions/:id/issue/list",
  "GET /api/sessions/:id/issue/labels",
  "GET /api/sessions/:id/issue/statuses",
  "GET /api/sessions/:id/issue/trackers",
  "GET /api/sessions/:id/issue/comments",
  "POST /api/sessions/:sessionId/issue/create",
  "POST /api/sessions/:sessionId/issue/comment",
  "POST /api/sessions/:sessionId/issue/comment/edit",
  "POST /api/sessions/:sessionId/issue/edit",
  "POST /api/sessions/:sessionId/issue/status",
  "POST /api/sessions/:sessionId/issue/assign",
  "POST /api/sessions/:sessionId/issue/label/create",
  "POST /api/sessions/:sessionId/issue/label/edit",
  "GET /api/sessions/:id/source/status",
  "GET /api/sessions/:id/source/tree",
  "GET /api/sessions/:id/source/search",
  "GET /api/sessions/:id/source/cat",
  "GET /api/sessions/:id/source/log",
  "GET /api/sessions/:id/source/blame",
  "GET /api/sessions/:id/source/show",
  "GET /api/sessions/:id/host-sessions",
  "GET /api/sessions/:id/host-session-logs",
  "POST /api/sessions/:id/agent/spawn",
  "GET /api/sessions/:id/agent/result",
  "GET /api/sessions/:id/agent/roles",
  "GET /api/sessions/:id/agent/params",
  "POST /api/sessions/:parentId/spawn",
  "GET /api/sessions/:parentId/children",
  "GET /api/sessions/:parentId/children/:childId",
  "POST /api/sessions/:parentId/children/:childId/message",
  "POST /api/sessions/:parentId/children/:childId/archive",
  "POST /api/sessions/:parentId/children/:childId/notify-on-merge",
  "POST /api/sessions/:sessionId/notify-on-merge-self",
  "POST /api/sessions/:id/branch/reset-to-base",
  "GET /api/sessions/:sessionId/cohort",
  "POST /api/sessions/:sessionId/report",
  "POST /api/sessions/:sessionId/voice-note",
  "POST /api/sessions/:sessionId/bug-report",
  "POST /api/sessions/:sessionId/propose-actions",
  "GET /api/egress/decision",
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
      // Include stores for conditionally registered routes or the snapshot will omit them.
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
