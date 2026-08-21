/**
 * FileReviewFooter — the review controls strip (draft count, past-reviews
 * disclosure, Cancel/Send) shared by the file-viewer dialog and the Present tab
 * (docs/219). Moved verbatim from `FilePreviewModal`'s footer + `PastReviews`.
 *
 * `onCancel` is optional: the dialog passes its close handler, Present omits it
 * (there's no modal to close).
 */

import { useState, type ReactNode } from "react";
import { PaperPlaneTiltIcon, CaretDownIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";
import { Button } from "../ui/button.js";
import type { FileReview } from "../../../server/shared/types.js";

function PastReviews({ history }: { history: FileReview[] }) {
  const [expanded, setExpanded] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  if (history.length === 0) return null;

  return (
    <div className="text-xs">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-(--color-text-secondary) hover:text-(--color-text-primary) cursor-pointer"
      >
        <CaretDownIcon
          size={ICON_SIZE.XS}
          className={`transition-transform ${expanded ? "" : "-rotate-90"}`}
        />
        Past reviews ({history.length})
      </button>
      {expanded && (
        <div className="mt-2 space-y-1">
          {history.map((review) => (
            <div key={review.id}>
              <button
                onClick={() => setOpenId(openId === review.id ? null : review.id)}
                className="flex items-center gap-2 w-full text-left px-2 py-1 rounded hover:bg-(--color-bg-hover) cursor-pointer"
              >
                <span className="text-(--color-text-secondary)">
                  {review.sentAt ? new Date(review.sentAt).toLocaleDateString() : "—"}
                </span>
                <span className="text-(--color-text-tertiary)">
                  {review.comments.length} comment{review.comments.length !== 1 ? "s" : ""}
                </span>
              </button>
              {openId === review.id && (
                <div className="ml-4 mt-1 mb-2 space-y-1">
                  {/* docs/260 — the note that framed this review, kept beside
                      the comments it was sent with. */}
                  {review.note && (
                    <div className="text-xs p-2 rounded border-l-2 border-l-(--color-border-secondary) bg-(--color-bg-tertiary)">
                      <span className="block text-[10px] uppercase tracking-wide text-(--color-text-tertiary)">
                        Note
                      </span>
                      <span className="text-(--color-text-secondary) whitespace-pre-wrap">
                        {review.note}
                      </span>
                    </div>
                  )}
                  {review.comments.map((c) => (
                    <div
                      key={c.id}
                      className="text-xs p-2 rounded border-l-2 border-l-blue-400 bg-blue-950/20"
                    >
                      <span className="text-(--color-text-tertiary)">
                        {c.kind === "selection"
                          ? `«${c.quotedText.slice(0, 40)}${c.quotedText.length > 40 ? "…" : ""}»: `
                          : `Line ${c.line}: `}
                      </span>
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

export function FileReviewFooter({
  commentCount,
  history,
  canSend,
  composing = false,
  onSend,
  onCancel,
  sendDialog,
}: {
  commentCount: number;
  history: FileReview[];
  canSend: boolean;
  /** An unsaved comment editor is open — Send is held so the in-progress
   *  comment isn't silently dropped. Takes over the status slot to say so. */
  composing?: boolean;
  /** Opens the send-confirmation dialog (docs/260); it does not send. */
  onSend: () => void;
  onCancel?: () => void;
  /**
   * docs/260 — the send-confirmation dialog, passed in rather than built here.
   * The footer is shared by the file-viewer dialog and the Present tab, and
   * both get the dialog by rendering it in this one place; the state behind it
   * belongs to `useFileReviewControls`.
   */
  sendDialog?: ReactNode;
}) {
  return (
    // Wraps rather than overflows: the Cancel + Send pair alone is ~220px, so
    // at phone widths the status line drops to its own row instead of shoving
    // the buttons off the edge. `ml-auto` on the controls keeps them
    // right-aligned in both the one-row and two-row layouts.
    <div className="flex flex-wrap items-center px-6 py-3 border-t border-(--color-border-secondary) bg-(--color-bg-elevated) shrink-0 gap-x-4 gap-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0">
        {/* The reason Send is held replaces the draft count rather than
            sitting beside it — the composing state must not cost extra
            horizontal space, and the count is still on the button itself.
            Kept short enough (~153px) to sit beside "Past reviews" at 375px,
            so opening an editor doesn't add a row and shift the footer. */}
        <span className="text-xs text-(--color-text-secondary) whitespace-nowrap">
          {composing
            ? "Finish your comment first"
            : commentCount > 0
              ? `${commentCount} comment${commentCount !== 1 ? "s" : ""} — draft`
              : "no draft comments"}
        </span>
        <PastReviews history={history} />
      </div>
      <div className="flex items-center gap-2 shrink-0 ml-auto">
        {onCancel && (
          <Button variant="ghost" size="md" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button
          variant="primary"
          size="md"
          onClick={onSend}
          disabled={!canSend}
          title={composing ? "Save or cancel the open comment before sending" : undefined}
        >
          <PaperPlaneTiltIcon size={ICON_SIZE.SM} className="mr-1" />
          Send {commentCount > 0 ? `${commentCount} comment${commentCount !== 1 ? "s" : ""}` : "Comments"}
        </Button>
      </div>
      {sendDialog}
    </div>
  );
}
