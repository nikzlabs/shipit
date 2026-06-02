/**
 * Bug-report API routes (docs/164 — user bug filing).
 *
 * Surface:
 *   POST /api/sessions/:sessionId/bug-report   { title, body }
 *
 * The agent's `report_shipit_bug` tool (mcp-bug-bridge → worker
 * `/agent-ops/bug/report` → here) relays the draft. This route runs the
 * mandatory server-side redaction pipeline, stamps the platform build, and
 * emits a `bug_report_card` into the chat for the user to review. It does NOT
 * file anything — creation only happens after the user confirms the card, via
 * the `submit_bug_report` WS message. Filing under the user's own GitHub
 * identity therefore stays consent-gated.
 */

import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import { resolveSessionDir } from "./api-routes.js";
import { getErrorMessage } from "./validation.js";
import { resolveBuildId } from "./build-id.js";
import { compileBugReport, type BugReportProducer } from "./services/bug-report.js";

export async function registerBugReportRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  app.post<{
    Params: { sessionId: string };
    Body: { title?: string; body?: string };
  }>(
    "/api/sessions/:sessionId/bug-report",
    async (request, reply: FastifyReply) => {
      const { sessionId } = request.params;
      const title = typeof request.body?.title === "string" ? request.body.title.trim() : "";
      const body = typeof request.body?.body === "string" ? request.body.body : "";
      if (!title) {
        reply.code(400).send({ error: "title is required" });
        return;
      }
      if (!body.trim()) {
        reply.code(400).send({ error: "body is required" });
        return;
      }

      // Confirm the session exists (and resolves to a real dir) before doing work.
      if (!resolveSessionDir(deps.sessionManager, sessionId, reply)) return;
      const session = deps.sessionManager.get(sessionId);

      const runner = deps.runnerRegistry.get(sessionId);
      if (!runner) {
        // No active runner means there's nowhere to render the consent card.
        reply.code(409).send({ error: "Session is not active — open it to file a bug report." });
        return;
      }

      const producer: BugReportProducer = session?.kind === "ops" ? "ops" : "session";
      const cardId = `bug-card-${randomUUID()}`;

      try {
        const compiled = await compileBugReport({
          cardId,
          title,
          body,
          producer,
          buildId: resolveBuildId(),
          // Prefer an injected Stage-2 runner (test mode wires a no-op);
          // otherwise derive it from the session's own agent CLI.
          ...(deps.bugReportModelRunner
            ? { run: deps.bugReportModelRunner }
            : session?.agentId
              ? { agentId: session.agentId }
              : {}),
        });

        runner.emitMessage({
          type: "bug_report_card",
          sessionId,
          cardId: compiled.cardId,
          title: compiled.title,
          body: compiled.body,
          stage2Ran: compiled.stage2Ran,
          producer: compiled.producer,
          ...(deps.githubAuthManager.getStatus().username
            ? { filedAs: deps.githubAuthManager.getStatus().username }
            : {}),
          createdAt: new Date().toISOString(),
        });

        return {
          ok: true,
          cardId: compiled.cardId,
          stage2Ran: compiled.stage2Ran,
          message:
            "A redacted bug-report card has been posted in the chat. The user must review and confirm it before anything is sent — nothing has been filed yet.",
        };
      } catch (err) {
        reply.code(500).send({ error: `Failed to compile bug report: ${getErrorMessage(err)}` });
      }
    },
  );
}
