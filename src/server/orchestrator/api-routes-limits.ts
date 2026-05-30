/**
 * Subscription-limits routes (docs/161).
 *
 * `POST /api/limits/refresh` runs an on-demand `/api/oauth/usage` fetch for a
 * provider (default Claude) and rebroadcasts the merged snapshot over the
 * global `subscription_limits` SSE event. This backs the header pill's refresh
 * button — the only way to surface the **low-usage** number the CLI event
 * stream omits below a warning threshold. The provider itself is single-flight
 * and 429-lockout-guarded, so the route is a thin pass-through.
 */

import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import type { AgentId } from "../shared/types.js";

const KNOWN_AGENTS: readonly AgentId[] = ["claude", "codex"];

export async function registerLimitsRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  app.post<{ Body?: { agentId?: string } }>(
    "/api/limits/refresh",
    async (request, reply) => {
      if (!deps.refreshSubscriptionLimits) {
        reply.code(503).send({ error: "Limits refresh unavailable" });
        return;
      }
      const raw = request.body?.agentId ?? "claude";
      if (!KNOWN_AGENTS.includes(raw as AgentId)) {
        reply.code(400).send({ error: `Unknown agentId: ${raw}` });
        return;
      }
      await deps.refreshSubscriptionLimits(raw as AgentId, "manual");
      reply.send({ ok: true });
    },
  );
}
