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
import type { EgressSettings, EgressSessionSettings } from "../shared/types.js";

describe("egress settings routes", () => {
  let app: FastifyInstance;
  let db: DatabaseManager;
  let store: EgressAllowlistStore;
  let reloadEgress: ReturnType<typeof vi.fn>;
  let broadcasts: { event: string; data: unknown }[];

  beforeEach(async () => {
    db = new DatabaseManager(":memory:");
    store = new EgressAllowlistStore(db);
    reloadEgress = vi.fn(async () => true);
    broadcasts = [];
    app = Fastify();
    const deps = {
      egressAllowlistStore: store,
      sseBroadcast: (event: string, data: unknown) => broadcasts.push({ event, data }),
      containerManager: { reloadEgress } as unknown,
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

  it("GET /api/egress/settings returns the default-on toggle + empty allowlist", async () => {
    const res = await app.inject({ method: "GET", url: "/api/egress/settings" });
    expect(res.statusCode).toBe(200);
    expect(res.json<EgressSettings>()).toEqual({ globalEnabled: true, globalHosts: [] });
  });

  it("PUT /api/egress/settings flips the global toggle + broadcasts", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/egress/settings",
      payload: { globalEnabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<EgressSettings>().globalEnabled).toBe(false);
    expect(store.getGlobalEnabled()).toBe(false);
    expect(broadcasts).toContainEqual({ event: "egress_settings", data: { globalEnabled: false, globalHosts: [] } });
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
    });
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
});
