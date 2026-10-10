import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import { resolveSessionDir } from "./api-routes.js";
import { getErrorMessage } from "./validation.js";
import { resolveBuildId } from "./build-id.js";
import { compileBugReport, type BugReportProducer } from "./services/bug-report.js";
import { emitChatCard } from "./chat-card-persistence.js";
import type { PersistedBugReport } from "./chat-history.js";
import { runnerForContainerCall } from "./restart-turn-reattach.js";
import { MAX_BUG_REPORT_BODY_LENGTH, MAX_BUG_REPORT_TITLE_LENGTH } from "../shared/bug-report-limits.js";

// Code points, as GitHub and the schema of the tool count them: a surrogate pair is one.
function characters(text: string): number {
  return text.replace(/[\u{10000}-\u{10FFFF}]/gu, "_").length;
}

function tooLong(field: "title" | "body", length: number, max: number, advice: string): string {
  const n = (value: number): string => value.toLocaleString("en-US");
  return `The ${field} of the report is ${n(length)} characters; the maximum is ${n(max)}. ${advice} Then call report_shipit_bug again.`;
}

export async function registerBugReportRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  app.post<{
    Params: { sessionId: string };
    Body: { title?: string; body?: string };
  }>(
    "/api/sessions/:sessionId/bug-report",
    { config: { containerAccessible: true } },
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
      // Before the report is compiled: no redaction runs on a text that is refused.
      const titleLength = characters(title);
      if (titleLength > MAX_BUG_REPORT_TITLE_LENGTH) {
        reply.code(413).send({
          error: tooLong("title", titleLength, MAX_BUG_REPORT_TITLE_LENGTH, "Shorten it."),
        });
        return;
      }
      const bodyLength = characters(body);
      if (bodyLength > MAX_BUG_REPORT_BODY_LENGTH) {
        reply.code(413).send({
          error: tooLong(
            "body",
            bodyLength,
            MAX_BUG_REPORT_BODY_LENGTH,
            "Shorten it: keep what happened and the steps to reproduce it, and quote only the log lines that show the problem.",
          ),
        });
        return;
      }

      if (!resolveSessionDir(deps.sessionManager, sessionId, reply)) return;
      const session = deps.sessionManager.get(sessionId);

      const runner = await runnerForContainerCall(deps, sessionId);
      if (!runner) {
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
          ...(deps.bugReportModelRunner
            ? { run: deps.bugReportModelRunner }
            : session?.agentId
              ? { agentId: session.agentId }
              : {}),
        });

        const filedAs = deps.githubAuthManager.getStatus().username;
        const createdAt = new Date().toISOString();

        const persistedCard: PersistedBugReport = {
          cardId: compiled.cardId,
          phase: "draft",
          title: compiled.title,
          body: compiled.body,
          stage2Ran: compiled.stage2Ran,
          producer: compiled.producer,
          createdAt,
          ...(filedAs ? { filedAs } : {}),
        };
        emitChatCard(
          runner,
          {
            type: "bug_report_card",
            sessionId,
            cardId: compiled.cardId,
            title: compiled.title,
            body: compiled.body,
            stage2Ran: compiled.stage2Ran,
            producer: compiled.producer,
            ...(filedAs ? { filedAs } : {}),
            createdAt,
          },
          { role: "assistant", text: "", bugReport: persistedCard },
          { chatHistoryManager: deps.chatHistoryManager, sessionId },
        );

        return {
          ok: true,
          cardId: compiled.cardId,
          stage2Ran: compiled.stage2Ran,
          message:
            "A redacted bug-report card has been posted in the chat. The user must review and confirm it before anything is sent — nothing has been filed yet. Their decision will reach you as a short [ShipIt] line in front of their next message (the issue number and URL on confirm, or a decline on cancel), so don't ask them how the card was resolved.",
        };
      } catch (err) {
        reply.code(500).send({ error: `Failed to compile bug report: ${getErrorMessage(err)}` });
      }
    },
  );
}
