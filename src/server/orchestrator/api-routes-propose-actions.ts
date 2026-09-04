/**
 * propose-actions API route (docs/207 / planning#155 — action checklist cards).
 *
 * Surface:
 *   POST /api/sessions/:sessionId/propose-actions   { title?, actions: [...] }
 *
 * The agent's `propose_actions` tool (the `shipit` bridge → worker
 * `/agent-ops/propose-actions` → here) relays a menu of one-or-more INDEPENDENT
 * optional follow-up actions. This route validates the payload, stamps emit-time
 * provenance (branch + HEAD), and emits an `action_checklist_card` into the chat
 * for the user to resolve with a single batched submit.
 *
 * The card is an immutable, reusable message composer — it has NO lifecycle, no
 * terminal state, and nothing to patch server-side on submit (a submit is just a
 * normal user message). So unlike the bug-report card there is no follow-up WS
 * update and no `update*Card` path; the record is written once on emit.
 */

import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import { resolveSessionDir } from "./api-routes.js";
import { emitChatCard } from "./chat-card-persistence.js";
import type { ActionChecklistCard } from "../shared/types.js";
// The validator and its bounds live in `shared/` so the session-side tool
// pre-checks with the SAME code, and a rejection reads identically wherever it
// is raised (docs/207).
import { validateProposeActions } from "../shared/propose-actions-validation.js";

export async function registerProposeActionsRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  app.post<{
    Params: { sessionId: string };
    Body: { title?: unknown; actions?: unknown };
  }>(
    "/api/sessions/:sessionId/propose-actions",
    { config: { containerAccessible: true } },
    async (request, reply: FastifyReply) => {
      const { sessionId } = request.params;

      const validated = validateProposeActions(request.body ?? {});
      if ("error" in validated) {
        reply.code(400).send({ error: validated.error });
        return;
      }

      // Confirm the session exists (and resolves to a real dir) before doing work.
      const sessionDir = resolveSessionDir(deps.sessionManager, sessionId, reply);
      if (!sessionDir) return;

      const runner = deps.runnerRegistry.get(sessionId);
      if (!runner) {
        // No active runner means there's nowhere to render the card.
        reply.code(409).send({ error: "Session is not active — open it to propose actions." });
        return;
      }

      // Stamp emit-time provenance so the submitted message can tell the agent
      // what the actions were proposed against. Failures here are non-fatal: the
      // card still works as a message composer without branch/HEAD.
      let branch: string | undefined;
      let headSha: string | undefined;
      try {
        const git = deps.createGitManager(sessionDir);
        branch = (await git.getCurrentBranch()) || undefined;
        const head = await git.getHeadHash();
        headSha = head ? head.slice(0, 8) : undefined;
      } catch {
        // No git / detached / fresh repo — provenance is best-effort.
      }

      const card: ActionChecklistCard = {
        cardId: `action-card-${randomUUID()}`,
        ...(validated.title ? { title: validated.title } : {}),
        actions: validated.actions,
        ...(branch ? { branch } : {}),
        ...(headSha ? { headSha } : {}),
        createdAt: new Date().toISOString(),
      };

      // Persist the card in-band with the proposing turn so it survives a session
      // switch / full reload, not just a WS reconnect. `emitChatCard` emits the
      // live card AND records it (anchored where the tool fired, not floating
      // above the whole turn) AND persists the in-progress turn immediately — the
      // single primitive that makes a transcript card impossible to ship
      // emit-only. The card has no lifecycle, so it is never patched after this.
      emitChatCard(
        runner,
        { type: "action_checklist_card", sessionId, card },
        { role: "assistant", text: "", actionChecklist: card },
        { chatHistoryManager: deps.chatHistoryManager, sessionId },
      );

      return { ok: true, cardId: card.cardId, count: card.actions.length };
    },
  );
}
