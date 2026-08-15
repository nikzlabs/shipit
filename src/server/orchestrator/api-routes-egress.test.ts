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
  // The session's RESOLVED egress config — the seam the Plugins card and the
  // plugin containers' enforcement read (planning#376). Absent = no resolver
  // wired, which must never render as a positive claim about reachability.
  // Typed as the real shape rather than a hand-written subset, so a fixture can
  // never describe a config the resolver could not produce (planning#380).
  let resolvedEgress: Map<string, ResolvedEgressConfig>;

  beforeEach(async () => {
    db = new DatabaseManager(":memory:");
    store = new EgressAllowlistStore(db);
    reloadEgress = vi.fn(async () => true);
    broadcasts = [];
    liveContainers = new Map();
    resolvedEgress = new Map();
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
      chatHistoryManager: {},
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
    expect(res.json<EgressSettings>()).toEqual({ globalEnabled: true, globalHosts: [], enforcementActive: true });
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
      data: { globalEnabled: false, globalHosts: [], enforcementActive: true },
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
        excludedBySessionPolicy: false,
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
        excludedBySessionPolicy: false,
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
      resolvedEgress.set("session-1", { contained: true, extraHosts: [], base: [".anthropic.com"] });
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
        excludedBySessionPolicy: true,
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
        excludedBySessionPolicy: false,
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
      chatHistoryManager: {},
    } as unknown as ApiDeps);
    await app2.ready();
    try {
      const settings = (await app2.inject({ method: "GET", url: "/api/egress/settings" })).json<EgressSettings>();
      expect(settings).toEqual({ globalEnabled: true, globalHosts: [], enforcementActive: false });
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
      // "Not knowable" must not become a positive claim of exclusion — the same
      // fail-open `excludedBySessionPolicy` takes for the grant report.
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
  });
});
