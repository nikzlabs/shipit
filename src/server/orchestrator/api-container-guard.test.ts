/**
 * docs/201 / planning#131 — container ↔ browser trust boundary guard.
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
  registerUntrustedContainerNetwork,
  clearUntrustedContainerNetworks,
  isUntrustedContainerIp,
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
const SERVICE_IP = "172.18.0.6";
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
        getSessionByAnyContainerIp: async (ip: string) =>
          ip === SERVICE_IP ? { sessionId: OWN_SESSION } : undefined,
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
    // A query-scoped container-facing route (Tier C egress decision): the session
    // arrives as ?session=, not in the path — exercises §3's query-param fallback.
    app.get("/api/egress/decision", { config: { containerAccessible: true } }, async () => ({ allow: false }));
    // docs/255 — the Ops host-session inventory. It reads a `?id=` FILTER that
    // names another session; §3 must still scope on the PATH segment, so an ops
    // container can query about any session but only ever through its own path.
    app.get<{ Params: { id: string } }>(
      "/api/sessions/:id/host-sessions",
      { config: { containerAccessible: true } },
      async () => ({ sessions: [] }),
    );
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

  it("treats a Compose service IP as a container origin", async () => {
    const denied = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
      remoteAddress: SERVICE_IP,
    });
    expect(denied.statusCode).toBe(403);
    const own = await app.inject({
      method: "GET",
      url: `/api/sessions/${OWN_SESSION}/services`,
      remoteAddress: SERVICE_IP,
    });
    expect(own.statusCode).toBe(200);
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
    // Own path + a filter naming another session: allowed (the filter is a
    // query, and the route's own Ops gate is what decides what it may return).
    const own = await app.inject({
      method: "GET",
      url: `/api/sessions/${OWN_SESSION}/host-sessions?id=sess-other`,
      remoteAddress: CONTAINER_IP,
    });
    expect(own.statusCode).toBe(200);
    // Another session's path: still refused by §3, unchanged by docs/255.
    const other = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-other/host-sessions",
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

// docs/262 — a container ShipIt runs but never registers used to be treated as
// MORE trusted than a session container: "not a known session" reads as
// "browser or host", which skips all three layers. The plugin installer runs
// third-party code, so its whole subnet is declared untrusted instead.
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
    // An IPv6 subnet would silently match nothing — and a subnet that matches
    // nothing is a subnet that is not denied.
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
    // The same routes still behave normally for everyone else.
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
  // docs/224 — gated agent merge (`gh pr merge`), sandbox dangerousGitHubOps grant.
  "POST /api/sessions/:id/pr/:number/merge",
  // github actions — gh run / gh workflow (reads)
  "GET /api/sessions/:id/actions/runs",
  "GET /api/sessions/:id/actions/runs/view",
  "GET /api/sessions/:id/actions/workflows",
  "GET /api/sessions/:id/actions/workflows/view",
  // `gh run rerun` — the group's one write. Re-executes already-committed
  // workflow content against an existing commit, and only for a run on the
  // session's OWN branch (enforced in `services/github.ts`). Deliberately not
  // accompanied by dispatch / cancel / delete routes: those choose new code or
  // destroy state.
  "POST /api/sessions/:id/actions/runs/rerun",
  // release — shipit release plan/prepare (docs/214)
  "POST /api/sessions/:id/release/plan",
  "POST /api/sessions/:id/release/prepare",
  // docs/250 — shipit session rename. Own-session scoped: the worker injects the
  // caller's own id, so an agent can only ever retitle itself.
  "POST /api/sessions/:id/rename",
  // issues — shipit issue
  "GET /api/sessions/:id/issue/view",
  "GET /api/sessions/:id/issue/list",
  "GET /api/sessions/:id/issue/labels",
  "GET /api/sessions/:id/issue/statuses",
  "GET /api/sessions/:id/issue/trackers",
  "GET /api/sessions/:id/issue/comments",
  "POST /api/sessions/:sessionId/issue/create",
  "POST /api/sessions/:sessionId/issue/comment",
  // planning#88 — `shipit issue comment edit`. Same posture as the writes around it;
  // the comment it may reach is additionally narrowed server-side to one on the
  // named issue that ShipIt itself authored.
  "POST /api/sessions/:sessionId/issue/comment/edit",
  "POST /api/sessions/:sessionId/issue/edit",
  "POST /api/sessions/:sessionId/issue/status",
  "POST /api/sessions/:sessionId/issue/assign",
  // planning#232 — `shipit issue label create` broker target; same posture as the
  // issue writes above (own-session scoped, do-then-surface card with undo,
  // tracker token stays orchestrator-side).
  "POST /api/sessions/:sessionId/issue/label/create",
  // planning#88 — `shipit issue label edit`, the same posture as `label create`: it
  // corrects a label that already exists (rename in place, so nothing is
  // re-labeled) and its Undo restores the prior values.
  "POST /api/sessions/:sessionId/issue/label/edit",
  // source — shipit source (ops sessions)
  "GET /api/sessions/:id/source/status",
  "GET /api/sessions/:id/source/tree",
  "GET /api/sessions/:id/source/search",
  "GET /api/sessions/:id/source/cat",
  "GET /api/sessions/:id/source/log",
  "GET /api/sessions/:id/source/blame",
  "GET /api/sessions/:id/source/show",
  // docs/255 — `shipit session find` / `shipit session list --all` (ops sessions).
  // Reached under the CALLER'S OWN id like every route here, and gated a second
  // time on the server-authoritative `session.kind === "ops"`. Returns metadata
  // only (id/title/branch/repo/parent/PR number+url+state) — never another
  // session's conversation, prompts, secrets, or workspace contents.
  "GET /api/sessions/:id/host-sessions",
  // agent — shipit agent run / shipit agent result. The result read is
  // own-session scoped like the spawn (the worker injects the caller's id), and
  // returns only that session's own persisted consult cards (planning#247).
  "POST /api/sessions/:id/agent/spawn",
  "GET /api/sessions/:id/agent/result",
  // session — shipit session create/list/view/wait/message/archive + notify-on-merge
  "POST /api/sessions/:parentId/spawn",
  "GET /api/sessions/:parentId/children",
  "GET /api/sessions/:parentId/children/:childId",
  "POST /api/sessions/:parentId/children/:childId/message",
  "POST /api/sessions/:parentId/children/:childId/archive",
  "POST /api/sessions/:parentId/children/:childId/notify-on-merge",
  // docs/239 — `shipit session notify-on-merge --self` arms a watch on the
  // CALLER's own PR, and the self-merge wake turn's first act is the explicit,
  // fully-gated branch reset. Both are own-session scoped (the worker injects the
  // caller's id) and neither accepts an agent-supplied target. The reset's Cancel
  // counterpart is deliberately browser-only.
  "POST /api/sessions/:sessionId/notify-on-merge-self",
  "POST /api/sessions/:id/branch/reset-to-base",
  // docs/233 (planning#243) — the upward channel: `shipit session whoami` resolves
  // the CALLING session's own cohort, and `shipit session report` pushes a
  // report to its parent / siblings. Own-session scoped like every route above:
  // the worker injects the caller's id and recipients are derived server-side
  // from `parentSessionId`, so neither route accepts an agent-supplied target.
  "GET /api/sessions/:sessionId/cohort",
  "POST /api/sessions/:sessionId/report",
  // bridges — voice_note / report_shipit_bug
  "POST /api/sessions/:sessionId/voice-note",
  "POST /api/sessions/:sessionId/bug-report",
  // docs/207 (planning#155) — the `propose_actions` tool relays an action checklist
  // card here; container-reachable so the worker can broker it.
  "POST /api/sessions/:sessionId/propose-actions",
  // docs/172 Tier C (planning#92) — the SNI proxy queries this for an unknown host.
  // Query-only: it returns allow/deny and may surface an allow-once card, but
  // cannot GRANT (granting is the browser-only `egress_decision` WS path).
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
      // NOTE: the review module's user-comment routes are registered
      // unconditionally by `buildApp` (it constructs its own FileReviewStore via
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
