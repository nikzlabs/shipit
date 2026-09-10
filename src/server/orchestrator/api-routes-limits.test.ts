import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerLimitsRoutes } from "./api-routes-limits.js";
import type { ApiDeps } from "./api-routes.js";
import type { LimitsRefreshResult } from "../shared/types.js";

describe("POST /api/limits/refresh", () => {
  let app: FastifyInstance;
  let calls: { modeKey: string; reason: string; routeId?: string }[];
  let results: LimitsRefreshResult[];

  async function build(deps: Partial<ApiDeps> = {}): Promise<void> {
    app = Fastify();
    await registerLimitsRoutes(app, {
      refreshSubscriptionLimits: vi.fn(async (modeKey, reason, routeId) => {
        calls.push({ modeKey, reason, routeId });
        return results;
      }),
      ...deps,
    } as unknown as ApiDeps);
    await app.ready();
  }

  beforeEach(() => {
    calls = [];
    results = [{ routeId: "acct-a", outcome: "updated" }];
  });

  afterEach(async () => {
    await app?.close();
  });

  it("scopes the refresh to the route the pill named", async () => {
    await build();
    const res = await app.inject({
      method: "POST",
      url: "/api/limits/refresh",
      payload: { serviceId: "anthropic", billingMode: "sub", routeId: "acct-a" },
    });

    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([{ modeKey: "anthropic:sub", reason: "manual", routeId: "acct-a" }]);
  });

  it("returns the per-route outcome so the button can explain itself", async () => {
    results = [{ routeId: "acct-a", outcome: "rate-limited", lockedUntil: 1_700_000_000_000 }];
    await build();
    const res = await app.inject({
      method: "POST",
      url: "/api/limits/refresh",
      payload: { serviceId: "anthropic", billingMode: "sub", routeId: "acct-a" },
    });

    expect(res.json()).toEqual({ ok: true, results });
  });

  it("still allows a group-wide refresh when no route is named", async () => {
    await build();
    const res = await app.inject({
      method: "POST",
      url: "/api/limits/refresh",
      payload: { serviceId: "anthropic", billingMode: "sub" },
    });

    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([{ modeKey: "anthropic:sub", reason: "manual", routeId: undefined }]);
  });

  it("rejects an unknown group and a malformed routeId", async () => {
    await build();
    const missingGroup = await app.inject({
      method: "POST",
      url: "/api/limits/refresh",
      payload: {},
    });
    expect(missingGroup.statusCode).toBe(400);

    const unknownService = await app.inject({
      method: "POST",
      url: "/api/limits/refresh",
      payload: { serviceId: "nope", billingMode: "sub" },
    });
    expect(unknownService.statusCode).toBe(400);

    const blankRoute = await app.inject({
      method: "POST",
      url: "/api/limits/refresh",
      payload: { serviceId: "anthropic", billingMode: "sub", routeId: "  " },
    });
    expect(blankRoute.statusCode).toBe(400);
    expect(calls).toEqual([]);
  });

  it("rejects a key mode, which reports no quota (docs/252 req 10)", async () => {
    await build();
    const res = await app.inject({
      method: "POST",
      url: "/api/limits/refresh",
      payload: { serviceId: "anthropic", billingMode: "key" },
    });
    expect(res.statusCode).toBe(400);
    expect(calls).toEqual([]);
  });

  it("503s when no limits registry is wired (test mode)", async () => {
    await build({ refreshSubscriptionLimits: undefined });
    const res = await app.inject({
      method: "POST",
      url: "/api/limits/refresh",
      payload: { serviceId: "anthropic", billingMode: "sub" },
    });
    expect(res.statusCode).toBe(503);
  });
});
