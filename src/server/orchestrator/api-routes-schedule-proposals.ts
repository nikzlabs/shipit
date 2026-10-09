import type { FastifyInstance, FastifyReply } from "fastify";
import {
  cancelScheduleProposal,
  confirmScheduleProposal,
  listSchedulesForAgent,
  proposeSchedule,
  type ScheduleProposalDeps,
} from "./services/schedule-proposal.js";
import { ServiceError } from "./services/types.js";
import { getErrorMessage } from "./validation.js";

/**
 * docs/324-scheduled-sessions reqs 8, 9. The agent's two routes are session-scoped, so a container
 * reaches them only for its own session; they read schedules and post a card, and write no
 * schedule. Confirm and Cancel are browser-only (no `containerAccessible`), so an agent cannot
 * confirm its own proposal.
 */
export function registerScheduleProposalRoutes(app: FastifyInstance, deps: ScheduleProposalDeps): void {
  const fail = (reply: FastifyReply, err: unknown, what: string): void => {
    if (err instanceof ServiceError) {
      reply.code(err.statusCode).send({ error: err.message });
      return;
    }
    reply.code(500).send({ error: `Failed to ${what}: ${getErrorMessage(err)}` });
  };

  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/schedules",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      if (!deps.sessionManager.get(request.params.id)) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }
      return { schedules: listSchedulesForAgent(deps) };
    },
  );

  app.post<{ Params: { id: string }; Body: { id?: unknown; text?: unknown } }>(
    "/api/sessions/:id/schedules/propose",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const { id, text } = request.body ?? {};
      if (typeof text !== "string" || !text.trim()) {
        reply.code(400).send({ error: "The proposal is empty. Pass the schedule as YAML." });
        return;
      }
      if (id !== undefined && (typeof id !== "string" || !id.trim())) {
        reply.code(400).send({ error: "--id names the schedule to change." });
        return;
      }
      try {
        return { card: proposeSchedule(deps, request.params.id, { id: id?.trim(), text }) };
      } catch (err) {
        fail(reply, err, "propose the schedule");
      }
    },
  );

  app.post<{ Params: { id: string; cardId: string }; Body: { timeZone?: unknown } | undefined }>(
    "/api/sessions/:id/schedule-proposals/:cardId/confirm",
    async (request, reply) => {
      try {
        const result = await confirmScheduleProposal(
          deps,
          request.params.id,
          request.params.cardId,
          request.body?.timeZone,
        );
        return result;
      } catch (err) {
        fail(reply, err, "confirm the schedule");
      }
    },
  );

  app.post<{ Params: { id: string; cardId: string } }>(
    "/api/sessions/:id/schedule-proposals/:cardId/cancel",
    async (request, reply) => {
      try {
        return cancelScheduleProposal(deps, request.params.id, request.params.cardId);
      } catch (err) {
        fail(reply, err, "cancel the schedule proposal");
      }
    },
  );
}
