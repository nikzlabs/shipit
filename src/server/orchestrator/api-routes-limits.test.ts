/**
 * Tests for the subscription-limits route (docs/161).
 *
 * Builds a real Fastify instance, registers only this route with a fake
 * `refreshSubscriptionLimits`, and drives it with `app.inject()` — no network.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerLimitsRoutes } from "./api-routes-limits.js";
import type { ApiDeps } from "./api-routes.js";
import type { AgentId, LimitsRefreshResult } from "../shared/types.js";

describe("POST /api/limits/refresh", () => {
  let app: FastifyInstance;
  let calls: { agentId: AgentId; reason: string; routeId?: string }[];
  let results: LimitsRefreshResult[];

  async function build(deps: Partial<ApiDeps> = {}): Promise<void> {
    app = Fastify();
    await registerLimitsRoutes(app, {
      refreshSubscriptionLimits: vi.fn(async (agentId, reason, routeId) => {
        calls.push({ agentId, reason, routeId });
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
    // Without the routeId the registry fans out over every connected account,
    // spending each one's slice of a budget that allows only a handful of
    // /api/oauth/usage calls per ~30 min.
    await build();
    const res = await app.inject({
      method: "POST",
      url: "/api/limits/refresh",
      payload: { agentId: "claude", routeId: "acct-a" },
    });

    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([{ agentId: "claude", reason: "manual", routeId: "acct-a" }]);
  });

  it("returns the per-route outcome so the button can explain itself", async () => {
    results = [{ routeId: "acct-a", outcome: "rate-limited", lockedUntil: 1_700_000_000_000 }];
    await build();
    const res = await app.inject({
      method: "POST",
      url: "/api/limits/refresh",
      payload: { agentId: "claude", routeId: "acct-a" },
    });

    expect(res.json()).toEqual({ ok: true, results });
  });

  it("still allows a provider-wide refresh when no route is named", async () => {
    await build();
    const res = await app.inject({
      method: "POST",
      url: "/api/limits/refresh",
      payload: { agentId: "claude" },
    });

    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([{ agentId: "claude", reason: "manual", routeId: undefined }]);
  });

  it("rejects an unknown agent and a malformed routeId", async () => {
    await build();
    const unknownAgent = await app.inject({
      method: "POST",
      url: "/api/limits/refresh",
      payload: { agentId: "gemini" },
    });
    expect(unknownAgent.statusCode).toBe(400);

    const blankRoute = await app.inject({
      method: "POST",
      url: "/api/limits/refresh",
      payload: { agentId: "claude", routeId: "  " },
    });
    expect(blankRoute.statusCode).toBe(400);
    expect(calls).toEqual([]);
  });

  it("503s when no limits registry is wired (test mode)", async () => {
    await build({ refreshSubscriptionLimits: undefined });
    const res = await app.inject({
      method: "POST",
      url: "/api/limits/refresh",
      payload: { agentId: "claude" },
    });
    expect(res.statusCode).toBe(503);
  });
});
