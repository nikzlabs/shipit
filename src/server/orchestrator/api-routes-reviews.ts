/**
 * File review API routes (unified review surface, docs/112).
 *
 * All reviews are scoped to a (session, file path) pair. Markdown files get
 * section-anchored comments, code files get line-anchored comments. The send
 * action constructs a structured prompt server-side and returns it; the
 * client dispatches it via the existing `send_message` flow.
 */

import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import { resolveSessionDir } from "./api-routes.js";

import {
  listFileReviews,
  getDraftReview,
  ensureDraftReview,
  addLineComment,
  addSectionComment,
  updateReviewComment,
  deleteReviewComment,
  deleteDraftReview,
  sendReview,
  generateAiReview,
  ServiceError,
} from "./services/index.js";
import type { GenerateTextFn } from "./services/reviews.js";
import { getErrorMessage } from "./validation.js";

type Source = "human" | "ai";

export async function registerReviewRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  // ----------------------------------------------------------------
  // List reviews for a (session, file)
  // ----------------------------------------------------------------
  app.get<{
    Params: { sessionId: string };
    Querystring: { filePath?: string };
  }>(
    "/api/sessions/:sessionId/file-reviews",
    async (request, reply) => {
      const { sessionId } = request.params;
      const filePath = request.query.filePath;
      if (!filePath) {
        reply.code(400).send({ error: "filePath is required" });
        return;
      }
      return { reviews: listFileReviews(deps.reviewStore!, sessionId, filePath) };
    },
  );

  // ----------------------------------------------------------------
  // Get current draft (without creating one)
  // ----------------------------------------------------------------
  app.get<{
    Params: { sessionId: string };
    Querystring: { filePath?: string };
  }>(
    "/api/sessions/:sessionId/file-reviews/draft",
    async (request, reply) => {
      const { sessionId } = request.params;
      const filePath = request.query.filePath;
      if (!filePath) {
        reply.code(400).send({ error: "filePath is required" });
        return;
      }
      const draft = getDraftReview(deps.reviewStore!, sessionId, filePath);
      if (!draft) {
        reply.code(404).send({ error: "No draft review found" });
        return;
      }
      return draft;
    },
  );

  // ----------------------------------------------------------------
  // Ensure draft (create if none, else return existing)
  // ----------------------------------------------------------------
  app.post<{
    Params: { sessionId: string };
    Body: { filePath: string };
  }>(
    "/api/sessions/:sessionId/file-reviews/draft",
    async (request, reply) => {
      const { sessionId } = request.params;
      const { filePath } = request.body;
      if (!filePath) {
        reply.code(400).send({ error: "filePath is required" });
        return;
      }
      const dir = resolveSessionDir(deps.sessionManager, sessionId, reply);
      if (!dir) return;
      try {
        return await ensureDraftReview(deps.reviewStore!, sessionId, filePath, dir);
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to ensure draft: ${getErrorMessage(err)}` });
      }
    },
  );

  // ----------------------------------------------------------------
  // Add a comment (body discriminates line vs section)
  // ----------------------------------------------------------------
  app.post<{
    Params: { sessionId: string; reviewId: string };
    Body:
      | { kind: "line"; line: number; text: string; source?: Source }
      | { kind: "section"; sectionHeading: string; sectionIndex: number; text: string; source?: Source };
  }>(
    "/api/sessions/:sessionId/file-reviews/:reviewId/comments",
    async (request, reply) => {
      try {
        const body = request.body;
        const source: Source = body.source ?? "human";
        if (body.kind === "line") {
          const comment = addLineComment(
            deps.reviewStore!,
            request.params.reviewId,
            body.line,
            body.text,
            source,
          );
          return comment;
        }
        const comment = addSectionComment(
          deps.reviewStore!,
          request.params.reviewId,
          body.sectionHeading,
          body.sectionIndex,
          body.text,
          source,
        );
        return comment;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to add comment: ${getErrorMessage(err)}` });
      }
    },
  );

  // ----------------------------------------------------------------
  // Update a comment
  // ----------------------------------------------------------------
  app.patch<{
    Params: { sessionId: string; reviewId: string; commentId: string };
    Body: { text: string };
  }>(
    "/api/sessions/:sessionId/file-reviews/:reviewId/comments/:commentId",
    async (request, reply) => {
      try {
        updateReviewComment(
          deps.reviewStore!,
          request.params.reviewId,
          request.params.commentId,
          request.body.text,
        );
        return { ok: true };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to update comment: ${getErrorMessage(err)}` });
      }
    },
  );

  // ----------------------------------------------------------------
  // Delete a comment
  // ----------------------------------------------------------------
  app.delete<{
    Params: { sessionId: string; reviewId: string; commentId: string };
  }>(
    "/api/sessions/:sessionId/file-reviews/:reviewId/comments/:commentId",
    async (request, reply) => {
      try {
        deleteReviewComment(
          deps.reviewStore!,
          request.params.reviewId,
          request.params.commentId,
        );
        return { ok: true };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to delete comment: ${getErrorMessage(err)}` });
      }
    },
  );

  // ----------------------------------------------------------------
  // Send a review (mark sent + return prompt)
  // ----------------------------------------------------------------
  app.post<{
    Params: { sessionId: string; reviewId: string };
  }>(
    "/api/sessions/:sessionId/file-reviews/:reviewId/send",
    async (request, reply) => {
      const dir = resolveSessionDir(deps.sessionManager, request.params.sessionId, reply);
      if (!dir) return;
      try {
        return await sendReview(deps.reviewStore!, request.params.reviewId, dir);
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to send review: ${getErrorMessage(err)}` });
      }
    },
  );

  // ----------------------------------------------------------------
  // Delete a draft (e.g., on close-without-saving)
  // ----------------------------------------------------------------
  app.delete<{
    Params: { sessionId: string; reviewId: string };
  }>(
    "/api/sessions/:sessionId/file-reviews/:reviewId",
    async (request, reply) => {
      try {
        deleteDraftReview(deps.reviewStore!, request.params.reviewId);
        return { ok: true };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to delete review: ${getErrorMessage(err)}` });
      }
    },
  );

  // ----------------------------------------------------------------
  // AI Review (markdown only)
  // ----------------------------------------------------------------
  //
  // Routes the prompt through the session runner when available — that's the
  // only path that works in containerized production, since `deps.generateText`
  // returns "" when no in-process agentFactory is available (agents live
  // inside session containers). Streams partial output back to the modal via
  // `ai_review_progress` WS messages so the user sees live activity instead
  // of a silent "Reviewing…" spinner.
  app.post<{
    Params: { sessionId: string; reviewId: string };
  }>(
    "/api/sessions/:sessionId/file-reviews/:reviewId/ai-review",
    async (request, reply) => {
      const { sessionId, reviewId } = request.params;
      const dir = resolveSessionDir(deps.sessionManager, sessionId, reply);
      if (!dir) return;

      const runner = deps.runnerRegistry.get(sessionId);

      // Stream partial assistant text to all attached viewers of this session
      // via runner.emitMessage (which buffers into the turn-event log so a
      // late-attaching viewer still sees in-flight progress).
      const emitProgress = (text: string): void => {
        runner?.emitMessage({
          type: "ai_review_progress",
          sessionId,
          reviewId,
          text,
        });
      };

      // Prefer the runner's own generateText (routes through the worker —
      // works in containerized production). Fall back to deps.generateText
      // for test mode (stubbed) and local mode (in-process agent).
      const generateText: GenerateTextFn = runner?.generateText
        ? (prompt, _cwd, opts) => runner.generateText!(prompt, { onProgress: opts?.onProgress })
        : (prompt, cwd, opts) => deps.generateText(prompt, cwd, opts);

      try {
        const comments = await generateAiReview(
          deps.reviewStore!,
          reviewId,
          dir,
          generateText,
          { onProgress: emitProgress },
        );
        runner?.emitMessage({
          type: "ai_review_complete",
          sessionId,
          reviewId,
          commentsAdded: comments.length,
        });
        return { comments };
      } catch (err) {
        const message = err instanceof ServiceError ? err.message : getErrorMessage(err);
        runner?.emitMessage({
          type: "ai_review_complete",
          sessionId,
          reviewId,
          commentsAdded: 0,
          error: message,
        });
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to generate AI review: ${message}` });
      }
    },
  );
}
