// eslint-disable-next-line no-restricted-imports -- useEffect: fetch draft on mount, keyboard handler
import { useState, useEffect, useCallback } from "react";
import { XIcon, RobotIcon, PaperPlaneTiltIcon, CaretDownIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import { useApi } from "../hooks/useApi.js";
import { MarkdownSectionComments } from "./MarkdownSectionComments.js";
import type { SectionCommentData } from "./MarkdownSectionComments.js";
import type { DocEntry, DocReview, ReviewComment } from "../../server/shared/types.js";

export interface DocReviewPanelProps {
  feature: DocEntry;
  content: string;
  onSendComments: (feature: DocEntry, prompt: string) => void;
  onClose: () => void;
}

function toSectionCommentData(comments: ReviewComment[]): SectionCommentData[] {
  return comments.map((c) => ({
    id: c.id,
    sectionHeading: c.sectionHeading,
    sectionIndex: c.sectionIndex,
    text: c.text,
    source: c.source,
  }));
}

function featureIdFromPath(docPath: string): string {
  // "docs/012-deployment/plan.md" → "012-deployment"
  const parts = docPath.split("/");
  return parts.length >= 2 ? parts[parts.length - 2] : docPath;
}

function ReviewHistory({ reviews, featureId: _featureId }: { reviews: DocReview[]; featureId: string }) {
  const [expanded, setExpanded] = useState(false);
  const sentReviews = reviews.filter((r) => r.status === "sent");
  const [expandedReview, setExpandedReview] = useState<string | null>(null);

  if (sentReviews.length === 0) return null;

  return (
    <div className="border-t border-(--color-border-secondary) pt-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-xs text-(--color-text-secondary) hover:text-(--color-text-primary) cursor-pointer"
      >
        <CaretDownIcon
          size={ICON_SIZE.XS}
          className={`transition-transform ${expanded ? "" : "-rotate-90"}`}
        />
        Past reviews ({sentReviews.length})
      </button>
      {expanded && (
        <div className="mt-2 space-y-1">
          {sentReviews.map((review) => (
            <div key={review.id} className="text-xs">
              <button
                onClick={() => setExpandedReview(expandedReview === review.id ? null : review.id)}
                className="flex items-center gap-2 w-full text-left px-2 py-1 rounded hover:bg-(--color-bg-hover) cursor-pointer"
              >
                <span className="text-(--color-text-secondary)">
                  {review.sentAt ? new Date(review.sentAt).toLocaleDateString() : "—"}
                </span>
                <span className="text-(--color-text-tertiary)">
                  {review.comments.length} comment{review.comments.length !== 1 ? "s" : ""}
                </span>
              </button>
              {expandedReview === review.id && (
                <div className="ml-4 mt-1 space-y-1 mb-2">
                  {review.comments.map((c) => (
                    <div
                      key={c.id}
                      className={`text-xs p-2 rounded border-l-2 ${
                        c.source === "ai" ? "border-l-purple-400 bg-purple-950/20" : "border-l-blue-400 bg-blue-950/20"
                      }`}
                    >
                      <span className="text-(--color-text-tertiary)">{c.sectionHeading || "(Intro)"}: </span>
                      <span className="text-(--color-text-secondary)">{c.text}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function DocReviewPanel({ feature, content, onSendComments, onClose }: DocReviewPanelProps) {
  const { get, post, patch, del } = useApi();
  const featureId = featureIdFromPath(feature.path);

  const [review, setReview] = useState<DocReview | null>(null);
  const [allReviews, setAllReviews] = useState<DocReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [aiLoading, setAiLoading] = useState(false);

  // Load or create draft on mount
  useEffect(() => {
    let cancelled = false;
    async function init() {
      try {
        // Try to get existing draft
        const draft = await get<DocReview>(`/api/features/${featureId}/reviews/draft`).catch(() => null);
        if (cancelled) return;

        if (draft) {
          setReview(draft);
        } else {
          // Create new draft
          const newDraft = await post<DocReview>(`/api/features/${featureId}/reviews`, {
            planPath: feature.path,
          });
          if (cancelled) return;
          setReview(newDraft);
        }

        // Load all reviews for history
        const { reviews } = await get<{ reviews: DocReview[] }>(`/api/features/${featureId}/reviews`);
        if (cancelled) return;
        setAllReviews(reviews);
      } catch (err) {
        console.error("[DocReviewPanel] Failed to load review:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void init();
    return () => { cancelled = true; };
  }, [featureId, feature.path, get, post]);

  const handleAddComment = useCallback(
    async (sectionHeading: string, sectionIndex: number, text: string) => {
      if (!review) return;
      try {
        const comment = await post<ReviewComment>(
          `/api/features/${featureId}/reviews/${review.id}/comments`,
          { sectionHeading, sectionIndex, text, source: "human" },
        );
        setReview((prev) => prev ? { ...prev, comments: [...prev.comments, comment] } : prev);
      } catch (err) {
        console.error("[DocReviewPanel] Failed to add comment:", err);
      }
    },
    [review, featureId, post],
  );

  const handleEditComment = useCallback(
    async (commentId: string, text: string) => {
      if (!review) return;
      try {
        await patch(`/api/features/${featureId}/reviews/${review.id}/comments/${commentId}`, { text });
        setReview((prev) => prev ? {
          ...prev,
          comments: prev.comments.map((c) => c.id === commentId ? { ...c, text } : c),
        } : prev);
      } catch (err) {
        console.error("[DocReviewPanel] Failed to edit comment:", err);
      }
    },
    [review, featureId, patch],
  );

  const handleDeleteComment = useCallback(
    async (commentId: string) => {
      if (!review) return;
      try {
        await del(`/api/features/${featureId}/reviews/${review.id}/comments/${commentId}`);
        setReview((prev) => prev ? {
          ...prev,
          comments: prev.comments.filter((c) => c.id !== commentId),
        } : prev);
      } catch (err) {
        console.error("[DocReviewPanel] Failed to delete comment:", err);
      }
    },
    [review, featureId, del],
  );

  const handleAiReview = useCallback(async () => {
    if (!review) return;
    setAiLoading(true);
    try {
      const { comments: newComments } = await post<{ comments: ReviewComment[] }>(
        `/api/features/${featureId}/reviews/${review.id}/ai-review`,
      );
      setReview((prev) => prev ? {
        ...prev,
        comments: [...prev.comments, ...newComments],
      } : prev);
    } catch (err) {
      console.error("[DocReviewPanel] AI review failed:", err);
    } finally {
      setAiLoading(false);
    }
  }, [review, featureId, post]);

  const handleSend = useCallback(async () => {
    if (!review || review.comments.length === 0) return;
    try {
      const { prompt } = await post<{ prompt: string }>(
        `/api/features/${featureId}/reviews/${review.id}/send`,
        { sessionId: "pending" },
      );
      onSendComments(feature, prompt);
    } catch (err) {
      console.error("[DocReviewPanel] Failed to send review:", err);
    }
  }, [review, featureId, feature, post, onSendComments]);

  const handleClose = useCallback(async () => {
    // If draft has no comments, delete it
    if (review?.comments.length === 0) {
      try {
        await del(`/api/features/${featureId}/reviews/${review.id}`);
      } catch { /* ignore */ }
    }
    onClose();
  }, [review, featureId, del, onClose]);

  if (loading) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-center h-full text-(--color-text-secondary) text-sm">
          Loading review...
        </div>
      </div>
    );
  }

  const commentCount = review?.comments.length ?? 0;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-(--color-border-secondary) bg-(--color-bg-elevated) shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="text-sm font-medium text-(--color-text-primary) truncate">
            Review: {feature.title}
          </h2>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="secondary"
            size="sm"
            onClick={handleAiReview}
            disabled={aiLoading}
          >
            <RobotIcon size={ICON_SIZE.SM} className="mr-1" />
            {aiLoading ? "Reviewing..." : "AI Review"}
          </Button>
          <button
            onClick={handleClose}
            className="p-1 rounded hover:bg-(--color-bg-hover) text-(--color-text-secondary) hover:text-(--color-text-primary) transition-colors"
            aria-label="Close"
          >
            <XIcon size={ICON_SIZE.MD} />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4">
        <MarkdownSectionComments
          content={content}
          comments={toSectionCommentData(review?.comments ?? [])}
          onAddComment={handleAddComment}
          onEditComment={handleEditComment}
          onDeleteComment={handleDeleteComment}
        />
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-4 py-3 border-t border-(--color-border-secondary) bg-(--color-bg-elevated) shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-xs text-(--color-text-secondary)">
            {commentCount} comment{commentCount !== 1 ? "s" : ""}
          </span>
          <ReviewHistory reviews={allReviews} featureId={featureId} />
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleSend}
            disabled={commentCount === 0}
          >
            <PaperPlaneTiltIcon size={ICON_SIZE.SM} className="mr-1" />
            Send Comments
          </Button>
        </div>
      </div>
    </div>
  );
}
