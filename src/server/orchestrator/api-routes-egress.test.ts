/**
 * Tests for the browser-only egress settings routes (docs/172, planning#92).
 *
 * These routes back the Settings → Network egress section. They are NOT
 * `containerAccessible` (verified by the golden route-table test in
 * `api-container-guard.test.ts`); here we cover the read/write behavior over a
 * real `EgressAllowlistStore` + in-memory DB.
 */

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
  // Mutable map of live container records, so a test can simulate "this session
  // has a running container that started Contained" for the pending-restart diff.
  let liveContainers: Map<string, { status: string; egressContainedAtStart?: boolean }>;
  /** docs/285 — sessions the PUT asked to rebuild, in order. */
  let reconcileCalls: string[];
  let reconcileOutcome: { action: string; message?: string; offerRescue?: boolean };
  // The session's RESOLVED egress config — the seam the Plugins card and the
  // plugin containers' enforcement read (planning#376). Absent = no resolver
  // wired, which must never render as a positive claim about reachability.
  // Typed as the real shape rather than a hand-written subset, so a fixture can
  // never describe a config the resolver could not produce (planning#380).
  let resolvedEgress: Map<string, ResolvedEgressConfig>;
  /** docs/285 — which session ids exist, and whether each has graduated. */
  let knownSessions: Map<string, { id: string; warm: boolean }>;
  /** docs/285 — persisted transcript cards, so the audit rule can be asserted. */
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
      // This deployment can enforce (enforcement on + sidecar image configured).
      egressEnforcementActive: true,
      sseBroadcast: (event: string, data: unknown) => broadcasts.push({ event, data }),
      containerManager: {
        reloadEgress,
        get: (id: string) => liveContainers.get(id),
        resolveEgress: (id: string) => resolvedEgress.get(id),
      } as unknown,
      runnerRegistry: { get: () => undefined },
      chatHistoryManager: { append: (_id: string, m: unknown) => appendedCards.push(m) },
      // docs/285 — both session routes now refuse an id no session owns, so the
      // fixture has to say which ids exist. `warm` matters too: the audit card is
      // suppressed while a session has not graduated.
      sessionManager: { get: (id: string) => knownSessions.get(id) },
      // docs/285 req 3 — the rebuild the PUT awaits. Records its calls so the
      // tests can assert WHEN it runs; `reconcileOutcome` lets one drive the
      // failure path.
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
    // Built-ins are present + removable (overridable defaults); the user host too.
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
    // A global add does not live-reload running sessions.
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

  // planning#376 — the route ran the reload (or didn't) and can see what is
  // running, so it reports what took effect instead of the browser predicting
  // the difference between the two scopes in a button tooltip.
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
      // `reloadEgress` answers false for a deployment with the Tier B/C
      // sidecars off, among others — the agent is then holding the old list,
      // and reading "session scope" as "it reloaded" would state the opposite.
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
        // `session` is reporting-only: the entry still lands at global scope.
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

    // docs/211 — a Network-off sandbox resolves to a lifeline-only config that
    // carries no user hosts at all. The entry saves and the reload runs, and
    // the session still cannot reach the host, for good.
    it("a session whose resolved config excludes the host is not reported as allowed", async () => {
      liveContainers.set("session-1", { status: "running", egressContainedAtStart: true });
      // `userHostsExcluded` is the SESSION-level fact `sandboxLifelineEgressConfig`
      // states, and asking it is the point: the route used to diff the host
      // against the config's entries instead, which is the reading planning#380
      // warns against — for an ordinary session that answer means the opposite
      // ("brand-new host, grant it"), and it only happened to work here because
      // the entry is added before the outcome is computed.
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
      // Suffix entries match the way the proxy matches them.
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

    /**
     * planning#383 — a deployment running `SESSION_EGRESS_DNS=0`. There is no
     * resolver to pin an allowed name's IPs and no proxy to permit its SNI, so
     * the entry saves and reaches nothing, in this session and in every other.
     * The route used to report it as live for anything started from now on.
     */
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
        // The entry is still saved — the user asked for it, and it takes effect
        // if the deployment ever turns the resolver on.
        expect(store.listHosts("session-1")).toEqual(["api.example.com"]);
      });

      it("says the same for the app-wide editor, where no session is in scope", async () => {
        // The fact is deployment-wide, so it is knowable without a session —
        // the one thing this route can state with nothing else to read.
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
        // Review finding: the no-session branch used to answer
        // `blocked-by-deployment` for every host — a fourth special case beside
        // the predicate, telling the app-wide editor that npm cannot be reached.
        const res = await floorApp.inject({
          method: "POST",
          url: "/api/egress/hosts",
          payload: { host: "registry.npmjs.org" },
        });
        expect(res.json<EgressHostAddResponse>().grant.reach).toBe("allowed");
      });

      it("does not call a session unreachable while its LIVE container runs Open", async () => {
        // Review finding: containment was read from the resolved policy alone,
        // so a session flipped to Contained but still running the container it
        // started Open with was reported as reaching nothing — while the Plugins
        // card, which asks what the container started with, said `allowed`. One
        // host, two surfaces, opposite answers: the defect class itself.
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
      // No running container in this test → nothing to diff/restart.
      startedContained: null,
      pendingRestart: false,
    });
  });

  it("reports enforcementActive=false when the deployment can't enforce (no sidecar image)", async () => {
    // A second app whose deps say enforcement is NOT active — the UI uses this to
    // warn "Contained — NOT enforced on this deployment".
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
      // docs/285 — with no explicit status, the deps-derived one can only be the
      // sidecar case; the `disabled` case is reported by production, which
      // passes the status rather than the boolean.
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
    store.setGlobalEnabled(true); // global Contained
    let res = await app.inject({
      method: "PUT",
      url: "/api/egress/session/session-1",
      payload: { override: false }, // force Open
    });
    expect(res.json<EgressSessionSettings>().effectiveContained).toBe(false);
    expect(store.getSessionOverride("session-1")).toBe(false);

    res = await app.inject({
      method: "PUT",
      url: "/api/egress/session/session-1",
      payload: { override: null }, // back to inherit
    });
    expect(res.json<EgressSessionSettings>().override).toBeNull();
    expect(res.json<EgressSessionSettings>().effectiveContained).toBe(true);
  });

  // docs/285 — both session routes used to answer for any id at all, and the PUT
  // used to accept any body. The composer hydrates from the GET on mount and
  // releases its Send barrier on the PUT's response, so a confident answer about
  // a session that does not exist, or a 200 for a write that changed nothing, is
  // worse than an error.
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
      // docs/285 — the docs/279 card records a CHANGE. A session that has not
      // graduated has no prior state for one to describe: "changed network
      // containment" above the first message would report an edit to a session
      // the user experiences as still being created.
      knownSessions.set("warm-1", { id: "warm-1", warm: true });
      appendedCards.length = 0;
      await app.inject({
        method: "PUT",
        url: "/api/egress/session/warm-1",
        payload: { override: false },
      });
      expect(appendedCards).toHaveLength(0);
      expect(store.getSessionOverride("warm-1")).toBe(false);

      // The same write on a graduated session still carries the audit card.
      await app.inject({
        method: "PUT",
        url: "/api/egress/session/session-1",
        payload: { override: false },
      });
      expect(appendedCards).toHaveLength(1);
    });

    it("PUT refuses a body whose override is not one of the three values", async () => {
      // The old route IGNORED this and returned 200 with the unchanged view —
      // indistinguishable, to the caller, from a write that took effect.
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

  // docs/172 — pending-restart diff: the resolved containment vs what the LIVE
  // container was actually created with. Egress topology is a creation-time
  // choice, so a mode change only takes effect on the next container start.
  describe("pendingRestart (live container started with a different mode)", () => {
    it("is false when no container is running (nothing to diff/restart)", async () => {
      const res = await app.inject({ method: "GET", url: "/api/egress/session/session-1" });
      const view = res.json<EgressSessionSettings>();
      expect(view.startedContained).toBeNull();
      expect(view.pendingRestart).toBe(false);
    });

    it("is false when the running container's mode matches the resolved mode", async () => {
      // Live container started Contained; global is Contained, no override → match.
      liveContainers.set("session-1", { status: "running", egressContainedAtStart: true });
      const res = await app.inject({ method: "GET", url: "/api/egress/session/session-1" });
      const view = res.json<EgressSessionSettings>();
      expect(view.startedContained).toBe(true);
      expect(view.effectiveContained).toBe(true);
      expect(view.pendingRestart).toBe(false);
    });

    it("flips to pending when the override resolves differently than the live container", async () => {
      // Live container started Contained; user forces Open → pending a restart.
      liveContainers.set("session-1", { status: "running", egressContainedAtStart: true });
      const res = await app.inject({
        method: "PUT",
        url: "/api/egress/session/session-1",
        payload: { override: false }, // force Open
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

  /**
   * planning#380 — the Tier C decision endpoint, for a session whose own resolved
   * config excludes the durable allowlist.
   *
   * This is not a display concern like the Plugins card: Tier A's ipset floor is
   * session-independent, so a Network-off sandbox can still address every IP
   * admitted for npm, PyPI or GitHub. A workload that pins a co-tenant IP reaches
   * the proxy with the excluded host's SNI, and a durable `allow` here is the
   * splice Tier C exists to refuse.
   */
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
      // Exactly `index.ts`'s injection.
      setEgressDurableSource((sessionId) => store.effectiveHosts(sessionId));
      store.addHost(EGRESS_GLOBAL_SCOPE, "fal.run");
    });
    afterEach(() => {
      _resetEgressPolicies();
      setEgressDurableSource(null);
    });

    it("honours the durable allowlist for an ordinary contained session", async () => {
      // Its own extras carry that host, so the live proxy asking about it is the
      // instance-scope case the reconciliation was written for.
      resolvedEgress.set("session-1", { contained: true, extraHosts: ["fal.run"] });
      expect((await ask("fal.run")).json()).toEqual({ allow: true });
    });

    it("refuses it for a Network-off sandbox, whose policy admits no user hosts", async () => {
      resolvedEgress.set("session-1", SANDBOX);
      expect((await ask("fal.run")).json()).toEqual({ allow: false });
      // Narrowed per session, not globally: an ordinary session carrying the same
      // durable host in its own extras is unaffected. (The lifeline hosts are not
      // asked about at all — the proxy queries this route only for a host outside
      // the static allowlist it was launched with.)
      resolvedEgress.set("session-2", { contained: true, extraHosts: ["fal.run"] });
      expect((await ask("fal.run", "session-2")).json()).toEqual({ allow: true });
    });

    it("refuses a decision the user took in that session too — off only tightens", async () => {
      // docs/211: `network` off is lifeline-only and "only ever tightens, never
      // loosens", and the Tier C card belongs to Network ON. A live allow-once
      // would re-widen a session the user sealed, and would survive into every
      // plugin container the session launches.
      resolvedEgress.set("session-1", SANDBOX);
      allowEgressHost("session-1", "fal.run");
      expect((await ask("fal.run")).json()).toEqual({ allow: false });
      // The same decision in an ordinary contained session still works — this is
      // a property of the session's policy, not a narrowing of allow-once.
      resolvedEgress.set("session-2", { contained: true, extraHosts: [] });
      allowEgressHost("session-2", "fal.run");
      expect((await ask("fal.run", "session-2")).json()).toEqual({ allow: true });
    });

    it("falls back to the durable answer when no resolver is wired", async () => {
      // "Not knowable" must not become a positive claim that no grant can work —
      // the predicate fails to `grantable` there, never to a `blocked-*`.
      expect((await ask("fal.run")).json()).toEqual({ allow: true });
    });
  });

  /**
   * The card is a grant OFFER, so it belongs to the sessions that can grant. The
   * pair of tests below is the whole rule: an ordinary session must keep carding
   * (breaking that would kill the Tier C allow-once flow outright), and a session
   * that admits no user hosts must not, because approving would either do nothing
   * or re-widen a sealed sandbox.
   */
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
      // A card the user may act on tomorrow is transcript content, not transport.
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
      // Review finding: the route reads the verdict exhaustively, and this is
      // the case a partial reading got wrong. The host is in that session's own
      // configured reach, so refusing it would be false and carding it would
      // offer a grant for something already allowed — and this route is
      // `containerAccessible`, so the agent can ask directly rather than only
      // through a proxy that would never ask about its own static list.
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

/**
 * docs/285 req 3 — the mode the user picks before the first message is the mode
 * that message's turn runs under, and this route is where that is delivered.
 *
 * Containment is plumbed at container creation and a running container cannot be
 * re-plumbed, so the pick has to reach a NEW container. Doing that here — at the
 * write, before the response — rather than at the first Send is the whole design:
 * the container is created immediately after the value it reads was written, so
 * there is no window for the two to disagree, and the composer's existing save
 * barrier covers the wait.
 */
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
    // The write is persisted BEFORE the rebuild, which is what lets container
    // creation read the picked value rather than a snapshot of it.
    expect(store.getSessionOverride("warm-1")).toBe(false);
  });

  it("leaves a GRADUATED session's container alone", async () => {
    // Restarting a container out from under a session the user is working in is
    // not a settings change, it is Rescue. Those keep the ordinary "applies on
    // next container start" pending state.
    const res = await put("live-1", false);
    expect(res.statusCode).toBe(200);
    expect(reconcileCalls).toEqual([]);
    expect(store.getSessionOverride("live-1")).toBe(false);
  });

  it("does not rebuild when the value did not actually change", async () => {
    store.setSessionOverride("warm-1", false);
    const res = await put("warm-1", false);
    expect(res.statusCode).toBe(200);
    expect(reconcileCalls).toEqual([]);
  });

  it("fails the write when the container could not be rebuilt", async () => {
    // Answering 200 here would tell the composer the mode is in force and
    // release Send — the one thing that must not happen, since the turn would
    // then run under the mode the user just replaced.
    outcome = { action: "aborted", message: "no space left on device", offerRescue: false };
    const res = await put("warm-1", true);
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/no space left on device/);
  });

  it("serializes two concurrent writes, so two rebuilds never interleave", async () => {
    // `restartContainer` has no guard of its own: two concurrent calls for one
    // session interleave a destroy and a create against each other. The client's
    // save barrier orders ONE surface's writes; two tabs, or the composer and
    // the settings dialog, are two clients.
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
        // Long enough that two unserialized rebuilds, started in the same tick,
        // are guaranteed to overlap.
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
    // Last write wins, and it is one of the two — not a torn value.
    expect([true, false]).toContain(store.getSessionOverride("warm-1"));
    await localApp.close();
  });

  it("still persists on a runtime with no rebuild wired", async () => {
    // `RUNTIME_MODE=local` has no containers. The override is durable there and
    // applies to whatever topology exists; the write must not fail.
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
