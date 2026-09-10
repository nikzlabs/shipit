import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { DatabaseManager } from "../shared/database.js";
import { EgressAllowlistStore, EGRESS_GLOBAL_SCOPE } from "./egress-allowlist-store.js";
import { registerEgressRoutes } from "./api-routes-egress.js";
import { allowEgressHost, setEgressDurableSource, _resetEgressPolicies } from "./egress-policy.js";
import type { ResolvedEgressConfig } from "./egress-allowlist.js";
import type { ApiDeps } from "./api-routes.js";
import type { CredentialStore } from "./credential-store.js";
import type {
  EgressSettings,
  EgressSessionSettings,
  EgressAllowlistView,
  EgressHostAddResponse,
} from "../shared/types.js";

const stubCredentialStore = {
  getAllMcpServers: () => ({}),
  getAllMcpOAuthTokens: () => ({}),
} as unknown as CredentialStore;

describe("egress settings routes", () => {
  let app: FastifyInstance;
  let db: DatabaseManager;
  let store: EgressAllowlistStore;
  let reloadEgress: ReturnType<typeof vi.fn>;
  let broadcasts: { event: string; data: unknown }[];
  let liveContainers: Map<string, { status: string; egressContainedAtStart?: boolean }>;
  let reconcileCalls: string[];
  let reconcileOutcome: { action: string; message?: string; offerRescue?: boolean };
  let resolvedEgress: Map<string, ResolvedEgressConfig>;
  let knownSessions: Map<string, { id: string; warm: boolean }>;
  let appendedCards: unknown[];

  beforeEach(async () => {
    db = new DatabaseManager(":memory:");
    store = new EgressAllowlistStore(db);
    reloadEgress = vi.fn(async () => true);
    broadcasts = [];
    reconcileOutcome = { action: "restarted" };
    liveContainers = new Map();
    resolvedEgress = new Map();
    appendedCards = [];
    knownSessions = new Map([
      ["session-1", { id: "session-1", warm: false }],
      ["s1", { id: "s1", warm: false }],
    ]);
    reconcileCalls = [];
    app = Fastify();
    const deps = {
      egressAllowlistStore: store,
      credentialStore: stubCredentialStore,
      egressEnforcementActive: true,
      sseBroadcast: (event: string, data: unknown) => broadcasts.push({ event, data }),
      containerManager: {
        reloadEgress,
        get: (id: string) => liveContainers.get(id),
        resolveEgress: (id: string) => resolvedEgress.get(id),
      } as unknown,
      runnerRegistry: { get: () => undefined },
      chatHistoryManager: { append: (_id: string, m: unknown) => appendedCards.push(m) },
      sessionManager: { get: (id: string) => knownSessions.get(id) },
      reconcileSessionEgress: async (sid: string) => {
        reconcileCalls.push(sid);
        return reconcileOutcome;
      },
    } as unknown as ApiDeps;
    await registerEgressRoutes(app, deps);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it("GET /api/egress/allowlist returns the effective list with provenance (built-in + user)", async () => {
    store.addHost(EGRESS_GLOBAL_SCOPE, "user.example.com");
    const res = await app.inject({ method: "GET", url: "/api/egress/allowlist" });
    expect(res.statusCode).toBe(200);
    const view = res.json<EgressAllowlistView>();
    expect(view.session).toBeNull();
    const builtin = view.entries.find((e) => e.host === ".github.com");
    expect(builtin).toMatchObject({ source: "builtin", removable: true });
    expect(view.entries.find((e) => e.host === "user.example.com")).toMatchObject({
      source: "user-global",
      removable: true,
    });
  });

  it("GET /api/egress/allowlist?session=<id> folds in per-session hosts + session view", async () => {
    store.addHost("session-1", "session.example.com");
    const res = await app.inject({ method: "GET", url: "/api/egress/allowlist?session=session-1" });
    const view = res.json<EgressAllowlistView>();
    expect(view.session?.sessionId).toBe("session-1");
    expect(view.entries.find((e) => e.host === "session.example.com")).toMatchObject({
      source: "user-session",
      removable: true,
    });
  });

  it("GET /api/egress/settings returns the default-on toggle + empty allowlist + enforcement", async () => {
    const res = await app.inject({ method: "GET", url: "/api/egress/settings" });
    expect(res.statusCode).toBe(200);
    expect(res.json<EgressSettings>()).toEqual({
      globalEnabled: true,
      globalHosts: [],
      enforcementActive: true,
      enforcementStatus: "active",
    });
  });

  it("PUT /api/egress/settings flips the global toggle + broadcasts (with enforcement)", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/egress/settings",
      payload: { globalEnabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<EgressSettings>().globalEnabled).toBe(false);
    expect(store.getGlobalEnabled()).toBe(false);
    expect(broadcasts).toContainEqual({
      event: "egress_settings",
      data: { globalEnabled: false, globalHosts: [], enforcementActive: true, enforcementStatus: "active" },
    });
  });

  it("includes enforcementActive in the allowlist view + per-session view", async () => {
    const globalView = (await app.inject({ method: "GET", url: "/api/egress/allowlist" })).json<EgressAllowlistView>();
    expect(globalView.enforcementActive).toBe(true);
    const sessionView = (
      await app.inject({ method: "GET", url: "/api/egress/allowlist?session=session-1" })
    ).json<EgressAllowlistView>();
    expect(sessionView.enforcementActive).toBe(true);
    expect(sessionView.session?.enforcementActive).toBe(true);
  });

  it("POST /api/egress/hosts adds a global host (applies on next start, no reload)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/egress/hosts",
      payload: { host: "api.example.com" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<EgressSettings>().globalHosts).toEqual(["api.example.com"]);
    expect(store.listHosts(EGRESS_GLOBAL_SCOPE)).toEqual(["api.example.com"]);
    expect(reloadEgress).not.toHaveBeenCalled();
  });

  it("POST /api/egress/hosts with a session scope reloads that session live", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/egress/hosts",
      payload: { host: "api.example.com", scope: "session-1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<EgressSessionSettings>().hosts).toEqual(["api.example.com"]);
    expect(reloadEgress).toHaveBeenCalledWith("session-1");
  });

  describe("the response reports what the add took effect on", () => {
    it("a session add is live everywhere, with nothing to restart", async () => {
      liveContainers.set("session-1", { status: "running", egressContainedAtStart: true });
      const res = await app.inject({
        method: "POST",
        url: "/api/egress/hosts",
        payload: { host: "api.example.com", scope: "session-1" },
      });
      expect(res.json<EgressHostAddResponse>().grant).toEqual({
        host: "api.example.com",
        scope: "session",
        liveNow: ["new-containers", "agent", "services"],
        staleUntilRestart: [],
        restartSessionId: null,
        reach: "grantable",
      });
    });

    it("a session add whose reload declined is reported as pending, not as live", async () => {
      reloadEgress.mockResolvedValueOnce(false);
      liveContainers.set("session-1", { status: "running", egressContainedAtStart: true });
      const res = await app.inject({
        method: "POST",
        url: "/api/egress/hosts",
        payload: { host: "api.example.com", scope: "session-1" },
      });
      expect(res.json<EgressHostAddResponse>().grant).toMatchObject({
        scope: "session",
        staleUntilRestart: ["agent", "services"],
        restartSessionId: "session-1",
      });
    });

    it("a global add names the AGENT as stale too, and offers that session's restart", async () => {
      liveContainers.set("session-1", { status: "running", egressContainedAtStart: true });
      const res = await app.inject({
        method: "POST",
        url: "/api/egress/hosts",
        payload: { host: "api.example.com", scope: "global", session: "session-1" },
      });
      const body = res.json<EgressHostAddResponse>();
      expect(body.grant).toEqual({
        host: "api.example.com",
        scope: "global",
        liveNow: ["new-containers"],
        staleUntilRestart: ["agent", "services"],
        restartSessionId: "session-1",
        reach: "grantable",
      });
      expect(store.listHosts(EGRESS_GLOBAL_SCOPE)).toEqual(["api.example.com"]);
      expect(store.listHosts("session-1")).toEqual([]);
      expect(reloadEgress).not.toHaveBeenCalled();
    });

    it("a session whose resolved config excludes the host is not reported as allowed", async () => {
      liveContainers.set("session-1", { status: "running", egressContainedAtStart: true });
      resolvedEgress.set("session-1", {
        contained: true,
        extraHosts: [],
        base: [".anthropic.com"],
        userHostsExcluded: true,
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/egress/hosts",
        payload: { host: "api.example.com", scope: "session-1" },
      });
      expect(res.json<EgressHostAddResponse>().grant).toEqual({
        host: "api.example.com",
        scope: "session",
        liveNow: [],
        staleUntilRestart: [],
        restartSessionId: null,
        reach: "blocked-by-session",
      });
    });

    it("a host the resolved config DOES carry is reported normally", async () => {
      liveContainers.set("session-1", { status: "running", egressContainedAtStart: true });
      resolvedEgress.set("session-1", { contained: true, extraHosts: [".example.com"] });
      const res = await app.inject({
        method: "POST",
        url: "/api/egress/hosts",
        payload: { host: "api.example.com", scope: "session-1" },
      });
      expect(res.json<EgressHostAddResponse>().grant).toMatchObject({
        reach: "allowed",
        staleUntilRestart: [],
      });
    });

    it("a global add with no session in scope offers no restart", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/egress/hosts",
        payload: { host: "api.example.com" },
      });
      expect(res.json<EgressHostAddResponse>().grant).toMatchObject({
        scope: "global",
        staleUntilRestart: ["agent", "services"],
        restartSessionId: null,
      });
    });

    describe("a deployment with no controlled resolver", () => {
      let floorApp: FastifyInstance;

      beforeEach(async () => {
        floorApp = Fastify();
        await registerEgressRoutes(floorApp, {
          egressAllowlistStore: store,
          credentialStore: stubCredentialStore,
          egressEnforcementActive: true,
          egressDnsControlDeployed: false,
          sseBroadcast: () => {},
          containerManager: {
            reloadEgress,
            get: (id: string) => liveContainers.get(id),
            resolveEgress: (id: string) => resolvedEgress.get(id),
          } as unknown,
          runnerRegistry: { get: () => undefined },
          chatHistoryManager: { append: () => {} },
          sessionManager: { get: (id: string) => knownSessions.get(id) },
        } as unknown as ApiDeps);
        await floorApp.ready();
      });
      afterEach(async () => {
        await floorApp.close();
      });

      it("reports a session add as reaching nothing, with no restart to offer", async () => {
        liveContainers.set("session-1", { status: "running", egressContainedAtStart: true });
        resolvedEgress.set("session-1", { contained: true, extraHosts: [] });
        const res = await floorApp.inject({
          method: "POST",
          url: "/api/egress/hosts",
          payload: { host: "api.example.com", scope: "session-1" },
        });
        expect(res.json<EgressHostAddResponse>().grant).toEqual({
          host: "api.example.com",
          scope: "session",
          liveNow: [],
          staleUntilRestart: [],
          restartSessionId: null,
          reach: "blocked-by-deployment",
        });
        expect(store.listHosts("session-1")).toEqual(["api.example.com"]);
      });

      it("says the same for the app-wide editor, where no session is in scope", async () => {
        const res = await floorApp.inject({
          method: "POST",
          url: "/api/egress/hosts",
          payload: { host: "api.example.com" },
        });
        expect(res.json<EgressHostAddResponse>().grant).toMatchObject({
          reach: "blocked-by-deployment",
          liveNow: [],
          staleUntilRestart: [],
        });
      });

      it("still reports a host on the Tier A floor as reachable", async () => {
        resolvedEgress.set("session-1", { contained: true, extraHosts: [] });
        const res = await floorApp.inject({
          method: "POST",
          url: "/api/egress/hosts",
          payload: { host: "registry.npmjs.org", scope: "session-1" },
        });
        expect(res.json<EgressHostAddResponse>().grant.reach).toBe("allowed");
      });

      it("and reports it as reachable with NO session in scope either", async () => {
        const res = await floorApp.inject({
          method: "POST",
          url: "/api/egress/hosts",
          payload: { host: "registry.npmjs.org" },
        });
        expect(res.json<EgressHostAddResponse>().grant.reach).toBe("allowed");
      });

      it("does not call a session unreachable while its LIVE container runs Open", async () => {
        liveContainers.set("session-1", { status: "running", egressContainedAtStart: false });
        resolvedEgress.set("session-1", { contained: true, extraHosts: [] });
        const res = await floorApp.inject({
          method: "POST",
          url: "/api/egress/hosts",
          payload: { host: "api.example.com", scope: "session-1" },
        });
        const grant = res.json<EgressHostAddResponse>().grant;
        expect(grant.reach).toBe("allowed");
        expect(grant.liveNow).toEqual(["new-containers", "agent", "services"]);
      });
    });
  });

  it("POST /api/egress/hosts reports a fail-closed live refresh failure", async () => {
    reloadEgress.mockRejectedValueOnce(new Error("refresh failed"));
    const res = await app.inject({
      method: "POST",
      url: "/api/egress/hosts",
      payload: { host: "api.example.com", scope: "session-1" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      error: "allowlist saved, but live service refresh failed closed",
      settings: { hosts: ["api.example.com"] },
    });
  });

  it("POST /api/egress/hosts 400s on a blank host", async () => {
    const res = await app.inject({ method: "POST", url: "/api/egress/hosts", payload: { host: "  " } });
    expect(res.statusCode).toBe(400);
  });

  it("DELETE on a built-in default suppresses it (overridable) and marks defaults customized", async () => {
    const before = await app.inject({ method: "GET", url: "/api/egress/allowlist" });
    const aDefault = before.json<EgressAllowlistView>().entries.find((e) => e.source === "builtin")!.host;

    const res = await app.inject({ method: "DELETE", url: "/api/egress/hosts", payload: { host: aDefault } });
    expect(res.statusCode).toBe(200);
    expect(store.isDefaultSuppressed(aDefault)).toBe(true);

    const after = await app.inject({ method: "GET", url: "/api/egress/allowlist" });
    const view = after.json<EgressAllowlistView>();
    expect(view.entries.some((e) => e.host === aDefault)).toBe(false);
    expect(view.defaultsCustomized).toBe(true);
  });

  it("POST /api/egress/defaults/restore un-suppresses every removed default", async () => {
    const aDefault = store.effectiveBase()[0];
    store.suppressDefault(aDefault);
    expect(store.hasSuppressedDefaults()).toBe(true);

    const res = await app.inject({ method: "POST", url: "/api/egress/defaults/restore" });
    expect(res.statusCode).toBe(200);
    expect(store.hasSuppressedDefaults()).toBe(false);
    expect(res.json<EgressAllowlistView>().entries.some((e) => e.host === aDefault)).toBe(true);
  });

  it("re-adding a removed built-in default un-suppresses it (not a redundant user row)", async () => {
    const aDefault = store.effectiveBase()[0];
    store.suppressDefault(aDefault);
    await app.inject({ method: "POST", url: "/api/egress/hosts", payload: { host: aDefault } });
    expect(store.isDefaultSuppressed(aDefault)).toBe(false);
    expect(store.listHosts(EGRESS_GLOBAL_SCOPE)).not.toContain(aDefault);
  });

  it("DELETE /api/egress/hosts removes a global host", async () => {
    store.addHost(EGRESS_GLOBAL_SCOPE, "api.example.com");
    const res = await app.inject({
      method: "DELETE",
      url: "/api/egress/hosts",
      payload: { host: "api.example.com" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<EgressSettings>().globalHosts).toEqual([]);
  });

  it("GET /api/egress/session/:id reports inherited containment + per-session hosts", async () => {
    store.addHost("session-1", "session.example.com");
    const res = await app.inject({ method: "GET", url: "/api/egress/session/session-1" });
    expect(res.statusCode).toBe(200);
    expect(res.json<EgressSessionSettings>()).toEqual({
      sessionId: "session-1",
      override: null,
      hosts: ["session.example.com"],
      enforcementStatus: "active",
      effectiveContained: true,
      globalEnabled: true,
      enforcementActive: true,
      startedContained: null,
      pendingRestart: false,
    });
  });

  it("reports enforcementActive=false when the deployment can't enforce (no sidecar image)", async () => {
    const app2 = Fastify();
    await registerEgressRoutes(app2, {
      egressAllowlistStore: store,
      credentialStore: stubCredentialStore,
      egressEnforcementActive: false,
      sseBroadcast: () => {},
      containerManager: { reloadEgress, get: () => undefined } as unknown,
      runnerRegistry: { get: () => undefined },
      chatHistoryManager: { append: () => {} },
      sessionManager: { get: (id: string) => knownSessions.get(id) },
    } as unknown as ApiDeps);
    await app2.ready();
    try {
      const settings = (await app2.inject({ method: "GET", url: "/api/egress/settings" })).json<EgressSettings>();
      expect(settings).toEqual({
        globalEnabled: true,
        globalHosts: [],
        enforcementActive: false,
        enforcementStatus: "no-sidecar",
      });
      const view = (await app2.inject({ method: "GET", url: "/api/egress/allowlist" })).json<EgressAllowlistView>();
      expect(view.enforcementActive).toBe(false);
    } finally {
      await app2.close();
    }
  });

  it("PUT /api/egress/session/:id sets and clears a containment override", async () => {
    store.setGlobalEnabled(true);
    let res = await app.inject({
      method: "PUT",
      url: "/api/egress/session/session-1",
      payload: { override: false },
    });
    expect(res.json<EgressSessionSettings>().effectiveContained).toBe(false);
    expect(store.getSessionOverride("session-1")).toBe(false);

    res = await app.inject({
      method: "PUT",
      url: "/api/egress/session/session-1",
      payload: { override: null },
    });
    expect(res.json<EgressSessionSettings>().override).toBeNull();
    expect(res.json<EgressSessionSettings>().effectiveContained).toBe(true);
  });

  describe("session-route validation", () => {
    it("GET refuses an unknown session instead of inventing a view for it", async () => {
      const res = await app.inject({ method: "GET", url: "/api/egress/session/nope" });
      expect(res.statusCode).toBe(404);
    });

    it("PUT refuses an unknown session and writes nothing", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/egress/session/nope",
        payload: { override: true },
      });
      expect(res.statusCode).toBe(404);
      expect(store.getSessionOverride("nope")).toBeNull();
    });

    it("writes NO audit card for the creation-time choice, and one for a later change", async () => {
      knownSessions.set("warm-1", { id: "warm-1", warm: true });
      appendedCards.length = 0;
      await app.inject({
        method: "PUT",
        url: "/api/egress/session/warm-1",
        payload: { override: false },
      });
      expect(appendedCards).toHaveLength(0);
      expect(store.getSessionOverride("warm-1")).toBe(false);

      await app.inject({
        method: "PUT",
        url: "/api/egress/session/session-1",
        payload: { override: false },
      });
      expect(appendedCards).toHaveLength(1);
    });

    it("PUT refuses a body whose override is not one of the three values", async () => {
      for (const payload of [{ override: "open" }, { override: 1 }, {}]) {
        const res = await app.inject({
          method: "PUT",
          url: "/api/egress/session/session-1",
          payload,
        });
        expect(res.statusCode).toBe(400);
      }
      expect(store.getSessionOverride("session-1")).toBeNull();
    });
  });

  describe("pendingRestart (live container started with a different mode)", () => {
    it("is false when no container is running (nothing to diff/restart)", async () => {
      const res = await app.inject({ method: "GET", url: "/api/egress/session/session-1" });
      const view = res.json<EgressSessionSettings>();
      expect(view.startedContained).toBeNull();
      expect(view.pendingRestart).toBe(false);
    });

    it("is false when the running container's mode matches the resolved mode", async () => {
      liveContainers.set("session-1", { status: "running", egressContainedAtStart: true });
      const res = await app.inject({ method: "GET", url: "/api/egress/session/session-1" });
      const view = res.json<EgressSessionSettings>();
      expect(view.startedContained).toBe(true);
      expect(view.effectiveContained).toBe(true);
      expect(view.pendingRestart).toBe(false);
    });

    it("flips to pending when the override resolves differently than the live container", async () => {
      liveContainers.set("session-1", { status: "running", egressContainedAtStart: true });
      const res = await app.inject({
        method: "PUT",
        url: "/api/egress/session/session-1",
        payload: { override: false },
      });
      const view = res.json<EgressSessionSettings>();
      expect(view.effectiveContained).toBe(false);
      expect(view.startedContained).toBe(true);
      expect(view.pendingRestart).toBe(true);
    });

    it("ignores a container that isn't running (startedContained stays null)", async () => {
      liveContainers.set("session-1", { status: "stopped", egressContainedAtStart: true });
      const res = await app.inject({ method: "GET", url: "/api/egress/session/session-1" });
      const view = res.json<EgressSessionSettings>();
      expect(view.startedContained).toBeNull();
      expect(view.pendingRestart).toBe(false);
    });
  });

  describe("GET /api/egress/decision — a session admitting no user hosts is answered here", () => {
    const SANDBOX = {
      contained: true,
      extraHosts: [] as string[],
      base: [".anthropic.com", "platform.claude.com"],
      userHostsExcluded: true,
    };
    const ask = (host: string, session = "session-1") =>
      app.inject({ method: "GET", url: `/api/egress/decision?host=${host}&session=${session}` });

    beforeEach(() => {
      _resetEgressPolicies();
      setEgressDurableSource((sessionId) => store.effectiveHosts(sessionId));
      store.addHost(EGRESS_GLOBAL_SCOPE, "fal.run");
    });
    afterEach(() => {
      _resetEgressPolicies();
      setEgressDurableSource(null);
    });

    it("honours the durable allowlist for an ordinary contained session", async () => {
      resolvedEgress.set("session-1", { contained: true, extraHosts: ["fal.run"] });
      expect((await ask("fal.run")).json()).toEqual({ allow: true });
    });

    it("refuses it for a Network-off sandbox, whose policy admits no user hosts", async () => {
      resolvedEgress.set("session-1", SANDBOX);
      expect((await ask("fal.run")).json()).toEqual({ allow: false });
      resolvedEgress.set("session-2", { contained: true, extraHosts: ["fal.run"] });
      expect((await ask("fal.run", "session-2")).json()).toEqual({ allow: true });
    });

    it("refuses a decision the user took in that session too — off only tightens", async () => {
      resolvedEgress.set("session-1", SANDBOX);
      allowEgressHost("session-1", "fal.run");
      expect((await ask("fal.run")).json()).toEqual({ allow: false });
      resolvedEgress.set("session-2", { contained: true, extraHosts: [] });
      allowEgressHost("session-2", "fal.run");
      expect((await ask("fal.run", "session-2")).json()).toEqual({ allow: true });
    });

    it("falls back to the durable answer when no resolver is wired", async () => {
      expect((await ask("fal.run")).json()).toEqual({ allow: true });
    });
  });

  describe("GET /api/egress/decision — the card follows what a grant could do", () => {
    let emitted: unknown[];
    let appended: unknown[];

    beforeEach(async () => {
      _resetEgressPolicies();
      emitted = [];
      appended = [];
      await app.close();
      app = Fastify();
      store.addHost(EGRESS_GLOBAL_SCOPE, "fal.run");
      setEgressDurableSource((sessionId) => store.effectiveHosts(sessionId));
      await registerEgressRoutes(app, {
        egressAllowlistStore: store,
        credentialStore: stubCredentialStore,
        egressEnforcementActive: true,
        sseBroadcast: () => {},
        containerManager: { reloadEgress, get: () => undefined, resolveEgress: (id: string) => resolvedEgress.get(id) },
        runnerRegistry: {
          get: () => ({ emitMessage: (m: unknown) => emitted.push(m), running: false }),
        },
        chatHistoryManager: { append: (_id: string, m: unknown) => appended.push(m) },
        sessionManager: { get: (id: string) => knownSessions.get(id) },
      } as unknown as ApiDeps);
      await app.ready();
    });
    afterEach(() => {
      _resetEgressPolicies();
      setEgressDurableSource(null);
    });

    const ask = (session: string) =>
      app.inject({ method: "GET", url: `/api/egress/decision?host=new.example.com&session=${session}` });

    it("cards an ordinary contained session's unknown host, and persists it", async () => {
      resolvedEgress.set("session-1", { contained: true, extraHosts: [] });
      expect((await ask("session-1")).json()).toEqual({ allow: false });
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({ type: "egress_prompt_card", host: "new.example.com" });
      expect(appended).toHaveLength(1);
    });

    it("offers no card to a session that admits no user hosts", async () => {
      resolvedEgress.set("session-1", {
        contained: true,
        extraHosts: [],
        base: [".anthropic.com"],
        userHostsExcluded: true,
      });
      expect((await ask("session-1")).json()).toEqual({ allow: false });
      expect(emitted).toEqual([]);
      expect(appended).toEqual([]);
    });

    it("offers a sealed session no card for a LIFELINE host either — it needs no grant", async () => {
      resolvedEgress.set("session-1", {
        contained: true,
        extraHosts: [],
        base: [".anthropic.com"],
        userHostsExcluded: true,
      });
      const res = await app.inject({
        method: "GET",
        url: "/api/egress/decision?host=api.anthropic.com&session=session-1",
      });
      expect(res.json()).toEqual({ allow: true });
      expect(emitted).toEqual([]);
      expect(appended).toEqual([]);
    });
  });
});

describe("changing an ungraduated session's mode rebuilds its container (docs/285)", () => {
  let app: FastifyInstance;
  let db: DatabaseManager;
  let store: EgressAllowlistStore;
  let reconcileCalls: string[];
  let outcome: { action: string; message?: string; offerRescue?: boolean };
  let sessions: Map<string, { id: string; warm: boolean }>;

  beforeEach(async () => {
    db = new DatabaseManager(":memory:");
    store = new EgressAllowlistStore(db);
    reconcileCalls = [];
    outcome = { action: "restarted" };
    sessions = new Map([
      ["warm-1", { id: "warm-1", warm: true }],
      ["live-1", { id: "live-1", warm: false }],
    ]);
    app = Fastify();
    await registerEgressRoutes(app, {
      egressAllowlistStore: store,
      credentialStore: stubCredentialStore,
      egressEnforcementActive: true,
      sseBroadcast: () => {},
      containerManager: { get: () => undefined, resolveEgress: () => undefined } as unknown,
      runnerRegistry: { get: () => undefined },
      chatHistoryManager: { append: () => {} },
      sessionManager: { get: (id: string) => sessions.get(id) },
      reconcileSessionEgress: async (sid: string) => {
        reconcileCalls.push(sid);
        return outcome;
      },
    } as unknown as ApiDeps);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  const put = (id: string, override: boolean | null) =>
    app.inject({ method: "PUT", url: `/api/egress/session/${id}`, payload: { override } });

  it("rebuilds before answering, so the caller's save barrier covers the wait", async () => {
    const res = await put("warm-1", false);
    expect(res.statusCode).toBe(200);
    expect(reconcileCalls).toEqual(["warm-1"]);
    expect(store.getSessionOverride("warm-1")).toBe(false);
  });

  it("leaves a GRADUATED session's container alone", async () => {
    const res = await put("live-1", false);
    expect(res.statusCode).toBe(200);
    expect(reconcileCalls).toEqual([]);
    expect(store.getSessionOverride("live-1")).toBe(false);
  });

  it("re-asks for a rebuild even when the value did not change, so a failure can self-heal", async () => {
    store.setSessionOverride("warm-1", false);
    const res = await put("warm-1", false);
    expect(res.statusCode).toBe(200);
    expect(reconcileCalls).toEqual(["warm-1"]);
  });

  it("rolls the write back when the rebuild is refused", async () => {
    store.setSessionOverride("warm-1", true);
    outcome = { action: "aborted", message: "breaker tripped", offerRescue: true };
    const res = await put("warm-1", false);
    expect(res.statusCode).toBe(503);
    expect(store.getSessionOverride("warm-1")).toBe(true);
  });

  it("fails the write when the container could not be rebuilt", async () => {
    outcome = { action: "aborted", message: "no space left on device", offerRescue: false };
    const res = await put("warm-1", true);
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/no space left on device/);
  });

  it("serializes two concurrent writes, so two rebuilds never interleave", async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    const localApp = Fastify();
    await registerEgressRoutes(localApp, {
      egressAllowlistStore: store,
      credentialStore: stubCredentialStore,
      egressEnforcementActive: true,
      sseBroadcast: () => {},
      containerManager: { get: () => undefined, resolveEgress: () => undefined } as unknown,
      runnerRegistry: { get: () => undefined },
      chatHistoryManager: { append: () => {} },
      sessionManager: { get: (id: string) => sessions.get(id) },
      reconcileSessionEgress: async () => {
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await new Promise((r) => setTimeout(r, 25));
        inFlight -= 1;
        return { action: "restarted" };
      },
    } as unknown as ApiDeps);
    await localApp.ready();

    await Promise.all([
      localApp.inject({
        method: "PUT", url: "/api/egress/session/warm-1", payload: { override: true },
      }),
      localApp.inject({
        method: "PUT", url: "/api/egress/session/warm-1", payload: { override: false },
      }),
    ]);

    expect(maxConcurrent).toBe(1);
    expect([true, false]).toContain(store.getSessionOverride("warm-1"));
    await localApp.close();
  });

  it("still persists on a runtime with no rebuild wired", async () => {
    const bare = Fastify();
    await registerEgressRoutes(bare, {
      egressAllowlistStore: store,
      credentialStore: stubCredentialStore,
      egressEnforcementActive: true,
      sseBroadcast: () => {},
      runnerRegistry: { get: () => undefined },
      chatHistoryManager: { append: () => {} },
      sessionManager: { get: (id: string) => sessions.get(id) },
    } as unknown as ApiDeps);
    await bare.ready();
    const res = await bare.inject({
      method: "PUT", url: "/api/egress/session/warm-1", payload: { override: true },
    });
    expect(res.statusCode).toBe(200);
    expect(store.getSessionOverride("warm-1")).toBe(true);
    await bare.close();
  });
});
