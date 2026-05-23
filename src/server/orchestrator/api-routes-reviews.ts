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
  addSelectionComment,
  updateReviewComment,
  deleteReviewComment,
  deleteDraftReview,
  sendReview,
  submitAiReviewComments,
  ServiceError,
} from "./services/index.js";
import type { AiReviewCommentInput } from "./services/index.js";
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
      | {
          kind: "selection";
          quotedText: string;
          contextBefore?: string;
          contextAfter?: string;
          text: string;
          source?: Source;
        };
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
        const comment = addSelectionComment(
          deps.reviewStore!,
          request.params.reviewId,
          body.quotedText,
          body.contextBefore ?? "",
          body.contextAfter ?? "",
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
  // Chat-native AI review write-back (docs/125)
  //
  // The session worker relays the agent's `submit_review_comments` tool call
  // here (worker injects the trusted SESSION_ID). The agent is allow-listed to
  // exactly the file the current review turn authorized — `runner.
  // activeReviewFilePath` — so a confused subagent can't draft comments on a
  // file the user never opened. `source: "ai"` is forced server-side.
  // ----------------------------------------------------------------
  app.post<{
    Params: { sessionId: string };
    Body: { filePath?: string; comments?: AiReviewCommentInput[] };
  }>(
    "/api/sessions/:sessionId/review-submit",
    async (request, reply) => {
      const { sessionId } = request.params;
      const filePath = request.body?.filePath;
      const comments = request.body?.comments;
      if (!filePath || !Array.isArray(comments)) {
        reply.code(400).send({ error: "filePath and comments[] are required" });
        return;
      }

      // Allow-list: only the file the current review turn authorized.
      const runner = deps.runnerRegistry.get(sessionId);
      if (runner?.activeReviewFilePath !== filePath) {
        reply.code(403).send({
          error: runner?.activeReviewFilePath
            ? `submit_review_comments is authorized for "${runner.activeReviewFilePath}", not "${filePath}".`
            : "No review is in progress for this session — submit_review_comments is only available during a review turn.",
        });
        return;
      }

      const dir = resolveSessionDir(deps.sessionManager, sessionId, reply);
      if (!dir) return;
      try {
        const result = await submitAiReviewComments(
          deps.reviewStore!,
          sessionId,
          filePath,
          dir,
          comments,
        );
        // Broadcast the updated draft so an open file-preview modal renders the
        // new AI comments live (and reconnecting viewers replay it).
        runner.emitMessage({ type: "review_updated", sessionId, filePath, review: result.review });
        return { ok: true, added: result.added, outdated: result.outdated };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to submit review comments: ${getErrorMessage(err)}` });
      }
    },
  );

}
