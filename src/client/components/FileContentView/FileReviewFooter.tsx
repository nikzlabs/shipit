/**
 * FileReviewFooter — the review controls strip (draft count, past-reviews
 * disclosure, Cancel/Send) shared by the file-viewer dialog and the Present tab
 * (docs/219). Moved verbatim from `FilePreviewModal`'s footer + `PastReviews`.
 *
 * `onCancel` is optional: the dialog passes its close handler, Present omits it
 * (there's no modal to close).
 */

import { useState } from "react";
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
                  {review.comments.map((c) => (
                    <div
                      key={c.id}
                      className={`text-xs p-2 rounded border-l-2 ${
                        c.source === "ai"
                          ? "border-l-purple-400 bg-purple-950/20"
                          : "border-l-blue-400 bg-blue-950/20"
                      }`}
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
  onSend,
  onCancel,
}: {
  commentCount: number;
  history: FileReview[];
  canSend: boolean;
  onSend: () => void;
  onCancel?: () => void;
}) {
  return (
    <div className="flex items-center justify-between px-6 py-3 border-t border-(--color-border-secondary) bg-(--color-bg-elevated) shrink-0 gap-4">
      <div className="flex items-center gap-3 min-w-0">
        <span className="text-xs text-(--color-text-secondary) whitespace-nowrap">
          {commentCount > 0
            ? `${commentCount} comment${commentCount !== 1 ? "s" : ""} — draft`
            : "no draft comments"}
        </span>
        <PastReviews history={history} />
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {onCancel && (
          <Button variant="ghost" size="md" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button variant="primary" size="md" onClick={onSend} disabled={!canSend}>
          <PaperPlaneTiltIcon size={ICON_SIZE.SM} className="mr-1" />
          Send {commentCount > 0 ? `${commentCount} comment${commentCount !== 1 ? "s" : ""}` : "Comments"}
        </Button>
      </div>
    </div>
  );
}
