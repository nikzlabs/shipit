/**
 * Tests for the browser-only egress settings routes (docs/172, SHI-90).
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
import type { ApiDeps } from "./api-routes.js";
import type { CredentialStore } from "./credential-store.js";
import type { EgressSettings, EgressSessionSettings, EgressAllowlistView } from "../shared/types.js";

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

  beforeEach(async () => {
    db = new DatabaseManager(":memory:");
    store = new EgressAllowlistStore(db);
    reloadEgress = vi.fn(async () => true);
    broadcasts = [];
    liveContainers = new Map();
    app = Fastify();
    const deps = {
      egressAllowlistStore: store,
      credentialStore: stubCredentialStore,
      // This deployment can enforce (enforcement on + sidecar image configured).
      egressEnforcementActive: true,
      sseBroadcast: (event: string, data: unknown) => broadcasts.push({ event, data }),
      containerManager: { reloadEgress, get: (id: string) => liveContainers.get(id) } as unknown,
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
});
