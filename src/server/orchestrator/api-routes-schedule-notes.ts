import type { FastifyInstance, FastifyReply } from "fastify";
import {
  decideNotesAccess,
  NotesAccessNeeded,
  readNotesForAgent,
  readRunNoteFile,
  readRunNotes,
  type ScheduleNotesAccessDeps,
} from "./services/schedule-notes.js";
import { ServiceError } from "./services/types.js";
import { getErrorMessage } from "./validation.js";

/**
 * docs/324-scheduled-sessions reqs 13, 27, 28, 30. The viewer's reads and the user's decision
 * on a notes access card are browser-only (no `containerAccessible`), so no agent can read
 * another run's notes past the check or grant its own access. The agent's one route is
 * session-scoped and checks the asking session.
 */
export function registerScheduleNotesRoutes(app: FastifyInstance, deps: ScheduleNotesAccessDeps): void {
  const fail = (reply: FastifyReply, err: unknown, what: string): void => {
    if (err instanceof NotesAccessNeeded) {
      reply.code(err.statusCode).send({ error: err.message, approval: err.approval, cardId: err.cardId });
      return;
    }
    if (err instanceof ServiceError) {
      reply.code(err.statusCode).send({ error: err.message });
      return;
    }
    reply.code(500).send({ error: `Failed to ${what}: ${getErrorMessage(err)}` });
  };

  app.get<{ Params: { id: string; runId: string } }>(
    "/api/schedules/:id/runs/:runId/notes",
    async (request, reply) => {
      try {
        return { notes: readRunNotes(deps, request.params.id, request.params.runId) };
      } catch (err) {
        fail(reply, err, "read the run's notes");
      }
    },
  );

  app.get<{ Params: { id: string; runId: string }; Querystring: { path?: string } }>(
    "/api/schedules/:id/runs/:runId/notes/file",
    async (request, reply) => {
      try {
        return { file: readRunNoteFile(deps, request.params.id, request.params.runId, request.query.path) };
      } catch (err) {
        fail(reply, err, "read the notes file");
      }
    },
  );

  for (const action of ["allow", "deny"] as const) {
    app.post<{ Params: { id: string; cardId: string } }>(
      `/api/sessions/:id/schedule-notes-access/:cardId/${action}`,
      async (request, reply) => {
        try {
          return decideNotesAccess(deps, request.params.id, request.params.cardId, action);
        } catch (err) {
          fail(reply, err, `${action} reading the notes`);
        }
      },
    );
  }

  app.get<{ Params: { id: string }; Querystring: { schedule?: string; run?: string; file?: string } }>(
    "/api/sessions/:id/schedule-notes",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      try {
        return readNotesForAgent(deps, request.params.id, request.query);
      } catch (err) {
        fail(reply, err, "read the schedule's notes");
      }
    },
  );
}
