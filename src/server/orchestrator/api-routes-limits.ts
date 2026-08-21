/**
 * Subscription-limits routes (docs/161).
 *
 * `POST /api/limits/refresh` runs an on-demand `/api/oauth/usage` fetch for one
 * **route** (a provider account, or a reserved env/API-key route) and
 * rebroadcasts the merged snapshot over the global `subscription_limits` SSE
 * event. This backs the header pill's refresh button — the only way to surface
 * the **low-usage** number the CLI event stream omits below a warning
 * threshold. The provider itself is single-flight and 429-lockout-guarded, so
 * the route is a thin pass-through.
 *
 * `routeId` is what makes the button match what it looks like. Omitting it fans
 * the refresh out over every connected account, and since `/api/oauth/usage`
 * allows only a handful of calls before a ~30 min lockout, one press on one
 * pill would spend every other subscription's budget as well.
 *
 * docs/252 req 10 — the group is named as `serviceId` + `billingMode` rather
 * than as an agent id, because quota belongs to a service's billing mode and
 * not to the CLI that reports it. Validated against the catalogue so an
 * unknown pair is a 400 rather than a silent no-op, and a mode with no quota to
 * report (`key`) is rejected outright: req 10 says such a mode shows no
 * indicator at all, so there is no button to press and nothing to refresh.
 *
 * The response carries the per-route outcome so the button can say why nothing
 * changed (rate-limited, signed out, upstream error) instead of spinning and
 * leaving the pill at `—`.
 */

import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import { getMode } from "../shared/catalogue/index.js";
import { limitsModeKey } from "../shared/types/usage-limits-types.js";

export async function registerLimitsRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  app.post<{ Body?: { serviceId?: string; billingMode?: string; routeId?: string } }>(
    "/api/limits/refresh",
    async (request, reply) => {
      if (!deps.refreshSubscriptionLimits) {
        reply.code(503).send({ error: "Limits refresh unavailable" });
        return;
      }
      const serviceId = request.body?.serviceId;
      const billingMode = request.body?.billingMode;
      if (typeof serviceId !== "string" || (billingMode !== "sub" && billingMode !== "key")) {
        reply.code(400).send({ error: "serviceId and billingMode ('sub' | 'key') are required" });
        return;
      }
      if (!getMode(serviceId, billingMode)) {
        reply.code(400).send({ error: `Unknown service or billing mode: ${serviceId}:${billingMode}` });
        return;
      }
      if (billingMode !== "sub") {
        reply.code(400).send({ error: "Only a subscription reports a quota" });
        return;
      }
      const routeId = request.body?.routeId;
      if (routeId !== undefined && (typeof routeId !== "string" || routeId.trim() === "")) {
        reply.code(400).send({ error: "routeId must be a non-empty string" });
        return;
      }
      const results = await deps.refreshSubscriptionLimits(
        limitsModeKey({ serviceId, billingMode }),
        "manual",
        routeId,
      );
      reply.send({ ok: true, results });
    },
  );
}
