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
  // Agent review write-back (docs/151)
  //
  // The session worker relays the agent's `submit_review_comments` tool call
  // here (worker injects the trusted SESSION_ID). The submission creates an
  // immutable `agent_reviews` row (with a snapshot of the file at review
  // time) and broadcasts `agent_review_added` so an inline card lands in the
  // chat transcript. Explicit chat-native review turns still narrow writes to
  // `runner.activeReviewFilePath`; normal agent/subagent turns may also post
  // review comments against their declared `filePath`.
  //
  // The response body carries the rendered structured findings the subagent
  // is instructed to echo verbatim — the parent receives them via the Task
  // tool result without needing a separate fetch tool.
  // ----------------------------------------------------------------
  app.post<{
    Params: { sessionId: string };
    Body: { filePath?: string; comments?: unknown[] };
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

      // If a chat-native review turn is active, keep its single-file
      // allow-list. Otherwise accept the submitted file path so regular agent
      // and subagent reviews can still land anchored comments.
      const runner = deps.runnerRegistry.get(sessionId);
      if (runner?.activeReviewFilePath && runner.activeReviewFilePath !== filePath) {
        reply.code(403).send({
          error: `submit_review_comments is authorized for "${runner.activeReviewFilePath}", not "${filePath}".`,
        });
        return;
      }

      if (!deps.agentReviewStore) {
        reply.code(500).send({ error: "Agent review store not configured" });
        return;
      }

      const dir = resolveSessionDir(deps.sessionManager, sessionId, reply);
      if (!dir) return;
      try {
        const result = await submitAiReviewComments(
          deps.agentReviewStore,
          sessionId,
          filePath,
          dir,
          comments,
        );
        // Broadcast a card-shaped event so the chat transcript shows the
        // review happened and a reconnecting viewer replays it.
        runner?.emitMessage({
          type: "agent_review_added",
          sessionId,
          filePath,
          reviewId: result.review.id,
          fileType: result.review.fileType,
          snapshotHash: result.review.snapshotHash,
          findingCount: result.review.comments.length,
          ...(result.review.summary ? { summary: result.review.summary } : {}),
          createdAt: result.review.createdAt,
        });
        return {
          ok: true,
          reviewId: result.review.id,
          snapshotHash: result.review.snapshotHash,
          findingCount: result.review.comments.length,
          added: result.added,
          rendered: result.rendered,
        };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to submit review comments: ${getErrorMessage(err)}` });
      }
    },
  );

  // ----------------------------------------------------------------
  // Fetch one agent review (snapshot + comments) for the chat-card modal.
  // ----------------------------------------------------------------
  app.get<{
    Params: { sessionId: string; reviewId: string };
  }>(
    "/api/sessions/:sessionId/agent-reviews/:reviewId",
    async (request, reply) => {
      const { sessionId, reviewId } = request.params;
      if (!deps.agentReviewStore) {
        reply.code(404).send({ error: "Agent review store not configured" });
        return;
      }
      const review = deps.agentReviewStore.getReview(reviewId);
      if (review?.sessionId !== sessionId) {
        reply.code(404).send({ error: "Agent review not found" });
        return;
      }
      return review;
    },
  );

}
