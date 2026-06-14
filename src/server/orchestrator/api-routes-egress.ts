/**
 * Egress decision API route (docs/172 Gap 1, SHI-90 — Tier C allow-once).
 *
 * Surface:
 *   GET /api/egress/decision?host=<sni>&session=<sessionId>
 *
 * The Tier C SNI proxy queries this for a host not in its static allowlist (its
 * `EGRESS_PROXY_DECISION_URL`). The orchestrator is the policy decision point:
 * it answers `{ allow }` from the per-session allow-once policy, and on a denied
 * host that hasn't been carded yet it emits the inline allow-once card for the
 * user. Deny-fast: the proxy resets the connection immediately on `allow:false`;
 * the agent retries, and once the user approves the next query returns `allow:true`.
 *
 * `containerAccessible: true` — the proxy reaches it from the agent's netns
 * (bridge). The endpoint is query-only: it can trigger a card and read a
 * decision, but it cannot GRANT anything (granting is the browser-only
 * `egress_decision` WS path), so an agent that calls it directly can at most
 * propose a card it can't approve.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import { emitChatCard } from "./chat-card-persistence.js";
import { isEgressHostAllowed, shouldCardEgressHost } from "./egress-policy.js";
import { normalizeHost } from "./egress-allowlist.js";
import type { PersistedEgressPrompt } from "./chat-history.js";

/** Stable per (session, host) so a re-denied host updates one card, never duplicates. */
export function egressCardId(sessionId: string, host: string): string {
  return `egress-${sessionId}-${normalizeHost(host)}`;
}

export async function registerEgressRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  app.get<{ Querystring: { host?: string; session?: string } }>(
    "/api/egress/decision",
    { config: { containerAccessible: true } },
    async (request, reply: FastifyReply) => {
      const host = typeof request.query.host === "string" ? request.query.host.trim() : "";
      const sessionId = typeof request.query.session === "string" ? request.query.session.trim() : "";
      if (!host || !sessionId) {
        reply.code(400).send({ error: "host and session are required" });
        return { allow: false };
      }

      if (isEgressHostAllowed(sessionId, host)) {
        return { allow: true };
      }

      // Not allowed → deny-fast. Surface a card (once) if the session is active.
      const runner = deps.runnerRegistry.get(sessionId);
      if (runner && shouldCardEgressHost(sessionId, host)) {
        const cardId = egressCardId(sessionId, host);
        const createdAt = new Date().toISOString();
        const persisted: PersistedEgressPrompt = { cardId, host: normalizeHost(host), phase: "pending", createdAt };
        emitChatCard(
          runner,
          { type: "egress_prompt_card", sessionId, cardId, host: normalizeHost(host), createdAt },
          { role: "assistant", text: "", egressPrompt: persisted },
          { chatHistoryManager: deps.chatHistoryManager, sessionId },
        );
      }
      return { allow: false };
    },
  );
}
