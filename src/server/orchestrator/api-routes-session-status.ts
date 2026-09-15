import type { FastifyInstance, FastifyReply } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import { resolveSessionDir } from "./api-routes.js";
import { validateSessionStatus } from "../shared/session-status-validation.js";
import { recordSessionStatus } from "./services/session-status.js";

export async function registerSessionStatusRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  app.post<{
    Params: { sessionId: string };
    Body: { status?: unknown; needsYou?: unknown; actions?: unknown; replaceActions?: unknown };
  }>(
    "/api/sessions/:sessionId/session-status",
    { config: { containerAccessible: true } },
    async (request, reply: FastifyReply) => {
      const { sessionId } = request.params;

      // docs/303 req 21 — with the setting off nothing changes from today, so a
      // resident spawned before a toggle must not write a card the user cannot
      // see. The mirror of the refusal `propose-actions` gives while it is on.
      if (!deps.credentialStore.getSessionStatusCard()) {
        reply.code(409).send({
          error:
            "The session status card is off, so there is no card to write: "
            + "offer follow-up actions with propose_actions instead.",
        });
        return;
      }

      const sessionDir = resolveSessionDir(deps.sessionManager, sessionId, reply);
      if (!sessionDir) return;

      const stored = deps.sessionManager.get(sessionId)?.sessionStatus;
      const validated = validateSessionStatus(request.body ?? {}, {
        hasStoredCard: stored !== undefined,
      });
      if ("error" in validated) {
        reply.code(400).send({ error: validated.error });
        return;
      }

      const runner = deps.runnerRegistry.get(sessionId);
      if (!runner) {
        reply.code(409).send({ error: "Session is not active — open it to write the status card." });
        return;
      }
      // Read before the awaits below: a stop and a successor turn can land inside
      // them, and `statusUpdated` belongs to the turn that made this call.
      const turnEpoch = runner.turnEpoch ?? 0;

      // Offers outlive the status they arrived with, so provenance is per offer
      // and is captured here, where the working tree is.
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

      const card = await recordSessionStatus(
        { sessionManager: deps.sessionManager, sseBroadcast: deps.sseBroadcast },
        sessionId,
        { ...validated, ...(branch ? { branch } : {}), ...(headSha ? { headSha } : {}) },
      );
      if (!card) {
        reply.code(404).send({ error: "Session not found." });
        return;
      }

      // req 12 — the turn asked for the card, so the settlement step must not
      // nudge for it, whether or not the call changed anything. A turn reset
      // during the awaits means this call belongs to a turn that is gone: the
      // card is still right, but a successor must not inherit its credit.
      if ((runner.turnEpoch ?? 0) === turnEpoch) runner.statusUpdated = true;

      return {
        ok: true,
        status: card.status,
        ...(card.needsYou ? { needsYou: card.needsYou } : {}),
        actions: card.actions.map((offer) => ({
          offerId: offer.offerId,
          id: offer.id,
          label: offer.label,
          taken: offer.takenAt !== undefined,
        })),
      };
    },
  );
}
