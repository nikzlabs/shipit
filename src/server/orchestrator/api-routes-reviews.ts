/**
 * File review API routes (unified review surface, docs/112).
 *
 * All reviews are scoped to a (session, file path) pair. Markdown files get
 * section-anchored comments, code files get line-anchored comments. The send
 * action constructs a structured prompt server-side and returns it; the
 * client dispatches it via the existing `send_message` flow.
 */

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import { resolveSessionDir } from "./api-routes.js";
import { emitOrReplaceChatCard } from "./chat-card-persistence.js";
import type { AiReviewCard } from "../shared/types.js";

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
  validateAiReviewSubmission,
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
  // Plain-text AI review write-back (docs/203)
  //
  // The session worker relays the parent agent's `submit_review` tool call here
  // (worker injects the trusted SESSION_ID). The submission is ONE freeform
  // markdown string; it persists a single review card in the chat transcript via
  // the side-channel card pattern (`emitOrReplaceChatCard` → `aiReview` field +
  // column). There is no snapshot, no anchoring, and no separate store.
  //
  // Authorization (non-negotiable, docs/203 §4): the tool is callable ONLY inside
  // a review turn (`runner.activeReviewFilePath` set by `send_review_message`)
  // and ONLY for the file under review. This is what stops an ordinary turn from
  // emitting review cards. A missing runner fails clearly rather than dropping
  // the card out of turn order.
  //
  // One card per review run: the reviewId is minted once per turn and reused, so
  // the parent's review → fix → re-review patches the same card in place.
  // ----------------------------------------------------------------
  app.post<{
    Params: { sessionId: string };
    Body: { filePath?: string; markdown?: string; reviewerLabel?: string };
  }>(
    "/api/sessions/:sessionId/review-submit",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const { sessionId } = request.params;
      const filePath = request.body?.filePath;

      // Runner lifetime: emitOrReplaceChatCard needs an active runner turn. Fail
      // clearly when none resolves (post-disposal / cross-session race) rather
      // than floating the card out of turn order with a bare append.
      const runner = deps.runnerRegistry.get(sessionId);
      if (!runner) {
        reply.code(409).send({ error: "No active session runner — submit_review must run inside a review turn." });
        return;
      }
      // Only callable inside an ACTIVE review turn, for only the file under
      // review. `activeReviewFilePath`/`activeReviewId` are reset at the next
      // turn START, not on completion, so they linger after a review turn ends;
      // gating on `runner.running` closes that window so a late/stale tool call
      // (after finalizeInProgress) can't patch recordedCards and re-run
      // replaceInProgress against an already-finalized turn.
      if (!runner.running || !runner.activeReviewFilePath) {
        reply.code(403).send({
          error: "submit_review is only callable inside an active review turn (started by /review or “Ask agent to review”).",
        });
        return;
      }
      if (runner.activeReviewFilePath !== filePath) {
        reply.code(403).send({
          error: `submit_review is authorized for "${runner.activeReviewFilePath}", not "${String(filePath)}".`,
        });
        return;
      }

      try {
        const submission = validateAiReviewSubmission(
          filePath,
          request.body?.markdown,
          request.body?.reviewerLabel,
        );

        // Mint the card id once per turn; reuse it on the re-review so the
        // patch lands on the same card instead of stacking a second one.
        runner.activeReviewId ??= randomUUID();
        const reviewId = runner.activeReviewId;

        const existing = runner.recordedCards.find(
          (c) => c.message.aiReview?.reviewId === reviewId,
        )?.message.aiReview;
        const card: AiReviewCard = {
          reviewId,
          filePath: submission.filePath,
          markdown: submission.markdown,
          reviewerLabel: submission.reviewerLabel,
          createdAt: existing?.createdAt ?? new Date().toISOString(),
          ...(existing ? { reReviewed: true } : {}),
        };

        const { replaced } = emitOrReplaceChatCard(
          runner,
          { type: "ai_review_added", sessionId, card },
          { role: "assistant", text: "", aiReview: card },
          { chatHistoryManager: deps.chatHistoryManager, sessionId },
          (m) => m.aiReview?.reviewId === reviewId,
        );

        return { ok: true, reviewId, reReviewed: replaced };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to submit review: ${getErrorMessage(err)}` });
      }
    },
  );

}
