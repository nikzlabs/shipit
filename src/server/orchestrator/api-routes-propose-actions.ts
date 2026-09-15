import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import { resolveSessionDir } from "./api-routes.js";
import { emitChatCard } from "./chat-card-persistence.js";
import type { ActionChecklistCard } from "../shared/types.js";
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

      // docs/303 req 21 — the tool is absent from the agent's context while the
      // card is on, so this only answers a resident process spawned before the
      // toggle; it must not post a transcript card the card has replaced.
      if (deps.credentialStore.getSessionStatusCard()) {
        reply.code(409).send({
          error:
            "The session status card is on, so follow-up actions are offered through it: "
            + "call session_status with `actions` instead.",
        });
        return;
      }

      const validated = validateProposeActions(request.body ?? {});
      if ("error" in validated) {
        reply.code(400).send({ error: validated.error });
        return;
      }

      const sessionDir = resolveSessionDir(deps.sessionManager, sessionId, reply);
      if (!sessionDir) return;

      const runner = deps.runnerRegistry.get(sessionId);
      if (!runner) {
        reply.code(409).send({ error: "Session is not active — open it to propose actions." });
        return;
      }

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
