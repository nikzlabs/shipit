/**
 * Review comment API routes.
 * Handles: design doc review CRUD, AI review, send review.
 */

import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "./api-routes.js";

import {
  listReviews,
  getDraftReview,
  createDraftReview,
  addReviewComment,
  updateReviewComment,
  deleteReviewComment,
  deleteDraftReview,
  sendReview,
  generateAiReview,
  ServiceError,
} from "./services/index.js";
import { getErrorMessage } from "./validation.js";

export async function registerReviewRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  // GET /api/features/:featureId/reviews — list all reviews
  app.get<{ Params: { featureId: string } }>(
    "/api/features/:featureId/reviews",
    async (request) => {
      return { reviews: listReviews(deps.reviewStore!, request.params.featureId) };
    },
  );

  // GET /api/features/:featureId/reviews/draft — get current draft
  app.get<{ Params: { featureId: string } }>(
    "/api/features/:featureId/reviews/draft",
    async (request, reply) => {
      const draft = getDraftReview(deps.reviewStore!, request.params.featureId);
      if (!draft) {
        reply.code(404).send({ error: "No draft review found" });
        return;
      }
      return draft;
    },
  );

  // POST /api/features/:featureId/reviews — create a new draft
  app.post<{ Params: { featureId: string }; Body: { planPath: string } }>(
    "/api/features/:featureId/reviews",
    async (request, reply) => {
      try {
        return await createDraftReview(
          deps.reviewStore!,
          request.params.featureId,
          request.body.planPath,
          deps.workspaceDir,
        );
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to create draft: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/features/:featureId/reviews/:reviewId/comments — add comment
  app.post<{
    Params: { featureId: string; reviewId: string };
    Body: { sectionHeading: string; sectionIndex: number; text: string; source?: string };
  }>(
    "/api/features/:featureId/reviews/:reviewId/comments",
    async (request, reply) => {
      try {
        const { sectionHeading, sectionIndex, text, source } = request.body;
        const comment = addReviewComment(
          deps.reviewStore!,
          request.params.featureId,
          request.params.reviewId,
          sectionHeading,
          sectionIndex,
          text,
          (source as "human" | "ai") ?? "human",
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

  // PATCH /api/features/:featureId/reviews/:reviewId/comments/:commentId — update comment
  app.patch<{
    Params: { featureId: string; reviewId: string; commentId: string };
    Body: { text: string };
  }>(
    "/api/features/:featureId/reviews/:reviewId/comments/:commentId",
    async (request, reply) => {
      try {
        updateReviewComment(
          deps.reviewStore!,
          request.params.featureId,
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

  // DELETE /api/features/:featureId/reviews/:reviewId/comments/:commentId — delete comment
  app.delete<{
    Params: { featureId: string; reviewId: string; commentId: string };
  }>(
    "/api/features/:featureId/reviews/:reviewId/comments/:commentId",
    async (request, reply) => {
      try {
        deleteReviewComment(
          deps.reviewStore!,
          request.params.featureId,
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

  // POST /api/features/:featureId/reviews/:reviewId/send — mark as sent
  app.post<{
    Params: { featureId: string; reviewId: string };
    Body: { sessionId: string };
  }>(
    "/api/features/:featureId/reviews/:reviewId/send",
    async (request, reply) => {
      try {
        return await sendReview(
          deps.reviewStore!,
          request.params.featureId,
          request.params.reviewId,
          request.body.sessionId,
          deps.workspaceDir,
        );
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to send review: ${getErrorMessage(err)}` });
      }
    },
  );

  // DELETE /api/features/:featureId/reviews/:reviewId — delete draft
  app.delete<{
    Params: { featureId: string; reviewId: string };
  }>(
    "/api/features/:featureId/reviews/:reviewId",
    async (request, reply) => {
      try {
        deleteDraftReview(
          deps.reviewStore!,
          request.params.featureId,
          request.params.reviewId,
        );
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

  // POST /api/features/:featureId/reviews/:reviewId/ai-review — trigger AI review
  app.post<{
    Params: { featureId: string; reviewId: string };
  }>(
    "/api/features/:featureId/reviews/:reviewId/ai-review",
    async (request, reply) => {
      try {
        const comments = await generateAiReview(
          deps.reviewStore!,
          request.params.featureId,
          request.params.reviewId,
          deps.workspaceDir,
          deps.generateText,
        );
        return { comments };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to generate AI review: ${getErrorMessage(err)}` });
      }
    },
  );
}
