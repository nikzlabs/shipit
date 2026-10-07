import type { FastifyInstance, FastifyReply } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import { resolveSessionDir } from "./api-routes.js";
import { validateSessionStatus } from "../shared/session-status-validation.js";
import { requireOfferDescriptions } from "../shared/session-status-offers.js";
import {
  formatSessionStatusCardFull,
  recordSessionStatus,
  turnsAgoCount,
} from "./services/session-status.js";

const CARD_OFF =
  "The session status card is off, so there is no card to read: "
  + "offer follow-up actions with propose_actions instead.";

export async function registerSessionStatusRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  /**
   * docs/303 req 48 — the agent fetches the card in full. A READ: it writes nothing,
   * touches neither `fresh` nor `writeSeq`, and does not set the turn's `statusUpdated`,
   * so reading the card never answers the update the turn owes. The per-turn block keeps
   * its cap (req 35); this is what makes the cap survivable, since a card can grow past
   * any cap and an offer whose payload was withheld cannot be repeated in a replacement.
   */
  app.get<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/session-status",
    { config: { containerAccessible: true } },
    async (request, reply: FastifyReply) => {
      if (!deps.credentialStore.getSessionStatusCard()) {
        reply.code(409).send({ error: CARD_OFF });
        return;
      }
      const session = deps.sessionManager.get(request.params.sessionId);
      if (!session) {
        reply.code(404).send({ error: "Session not found." });
        return;
      }
      const card = session.sessionStatus;
      if (!card) {
        return {
          ok: true,
          hasCard: false,
          text:
            "This session has no status card yet. Write the first one with `session_status`:"
            + " pass `status` — what the session is about and how far it got.",
        };
      }
      return {
        ok: true,
        hasCard: true,
        text: formatSessionStatusCardFull(card),
        card: {
          ...(card.lastTurn ? { lastTurn: card.lastTurn } : {}),
          status: card.status,
          fresh: card.fresh,
          turnSeq: card.turnSeq,
          needsYou: (card.needsYou ?? []).map((text, i) => ({
            text,
            addedTurnsAgo: turnsAgoCount(card.turnSeq, card.stepSeq?.[i]),
          })),
          actions: card.actions.map((offer) => ({
            offerId: offer.offerId,
            id: offer.id,
            label: offer.label,
            ...(offer.description ? { description: offer.description } : {}),
            ...(offer.defaultChecked ? { defaultChecked: true } : {}),
            payload: offer.payload,
            taken: offer.takenAt !== undefined,
            offeredTurnsAgo: turnsAgoCount(card.turnSeq, offer.offeredSeq),
            ...(offer.takenAt
              ? { takenTurnsAgo: turnsAgoCount(card.turnSeq, offer.takenSeq) }
              : {}),
          })),
        },
      };
    },
  );

  app.post<{
    Params: { sessionId: string };
    Body: {
      lastTurn?: unknown;
      status?: unknown;
      needsYou?: unknown;
      actions?: unknown;
      replaceActions?: unknown;
    };
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
      // req 26 — the status card asks for a description on every offer; the
      // shared item validator cannot, because `propose_actions` does not.
      const missingDescription = validated.actions
        ? requireOfferDescriptions(validated.actions)
        : null;
      if (missingDescription) {
        reply.code(400).send({ error: missingDescription });
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
        { sessionManager: deps.sessionManager },
        sessionId,
        { ...validated, ...(branch ? { branch } : {}), ...(headSha ? { headSha } : {}) },
      );
      if (!card) {
        reply.code(404).send({ error: "Session not found." });
        return;
      }
      // docs/324-scheduled-sessions req 21 — a run's list row carries its manual-step count.
      if (
        (card.needsYou?.length ?? 0) !== (stored?.needsYou?.length ?? 0)
        && deps.sessionManager.get(sessionId)?.scheduleId
      ) {
        deps.sseBroadcast("session_list", { sessions: deps.sessionManager.list() });
      }

      // req 12 — the turn asked for the card, so the settlement step must not
      // nudge for it, whether or not the call changed anything. A turn reset
      // during the awaits means this call belongs to a turn that is gone: the
      // card is still right, but a successor must not inherit its credit.
      if ((runner.turnEpoch ?? 0) === turnEpoch) runner.statusUpdated = true;

      return {
        ok: true,
        ...(card.lastTurn ? { lastTurn: card.lastTurn } : {}),
        status: card.status,
        ...(card.needsYou?.length ? { needsYou: card.needsYou } : {}),
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
