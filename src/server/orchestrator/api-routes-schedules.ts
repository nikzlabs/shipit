import type { FastifyInstance, FastifyReply } from "fastify";
import {
  createSchedule,
  getSchedule,
  listScheduleRuns,
  listSchedules,
  pauseSchedule,
  resumeSchedule,
  runScheduleNow,
  updateSchedule,
  type ScheduleServiceDeps,
} from "./services/schedules.js";
import { ServiceError } from "./services/types.js";
import { getErrorMessage } from "./validation.js";

/**
 * docs/324-scheduled-sessions — browser-only (no `containerAccessible`): an agent proposes a
 * schedule and the user confirms it (req 9), so no container may write one here.
 */
export function registerScheduleRoutes(app: FastifyInstance, deps: ScheduleServiceDeps): void {
  const fail = (reply: FastifyReply, err: unknown, what: string): void => {
    if (err instanceof ServiceError) {
      reply.code(err.statusCode).send({ error: err.message });
      return;
    }
    reply.code(500).send({ error: `Failed to ${what}: ${getErrorMessage(err)}` });
  };

  app.get("/api/schedules", async () => ({ schedules: listSchedules(deps) }));

  app.get<{ Params: { id: string } }>("/api/schedules/:id", async (request, reply) => {
    try {
      return { schedule: getSchedule(deps, request.params.id) };
    } catch (err) {
      fail(reply, err, "read the schedule");
    }
  });

  app.post<{ Body: unknown }>("/api/schedules", async (request, reply) => {
    try {
      const schedule = createSchedule(deps, request.body);
      reply.code(201);
      return { schedule };
    } catch (err) {
      fail(reply, err, "create the schedule");
    }
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/api/schedules/:id", async (request, reply) => {
    try {
      return { schedule: await updateSchedule(deps, request.params.id, request.body) };
    } catch (err) {
      fail(reply, err, "update the schedule");
    }
  });

  app.post<{ Params: { id: string } }>("/api/schedules/:id/pause", async (request, reply) => {
    try {
      return { schedule: await pauseSchedule(deps, request.params.id) };
    } catch (err) {
      fail(reply, err, "pause the schedule");
    }
  });

  app.post<{ Params: { id: string } }>("/api/schedules/:id/resume", async (request, reply) => {
    try {
      return { schedule: await resumeSchedule(deps, request.params.id) };
    } catch (err) {
      fail(reply, err, "resume the schedule");
    }
  });

  // Answers once the run is claimed; its start follows on the `schedule_run` event.
  app.post<{ Params: { id: string } }>("/api/schedules/:id/run", async (request, reply) => {
    try {
      const run = await runScheduleNow(deps, request.params.id);
      reply.code(202);
      return { run };
    } catch (err) {
      fail(reply, err, "start the run");
    }
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/api/schedules/:id/runs",
    async (request, reply) => {
      try {
        const limit = request.query.limit === undefined ? undefined : Number(request.query.limit);
        return { runs: listScheduleRuns(deps, request.params.id, limit) };
      } catch (err) {
        fail(reply, err, "read the runs");
      }
    },
  );
}
