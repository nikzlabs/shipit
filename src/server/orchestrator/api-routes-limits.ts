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
