/**
 * AgentReviewCard — inline chat affordance for an agent-authored review
 * (docs/151).
 *
 * Rendered at the chat-history position where the subagent's
 * `submit_review_comments` call landed. Carries enough metadata to summarize
 * the review (file path, finding count, optional summary line) and an
 * `[open]` button that opens the file in snapshot-mode FilePreviewModal so
 * pins line up with what the reviewer saw.
 *
 * Deliberately does NOT live in the file's review history list — that
 * surface is for the human-authored draft/sent lifecycle, which agent
 * reviews don't participate in.
 */

import { ArrowSquareOutIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";

export interface AgentReviewCardProps {
  reviewId: string;
  filePath: string;
  findingCount: number;
  snapshotHash: string;
  summary?: string;
  createdAt: string;
  /**
   * Called when the user clicks the open action. The host wires this to the
   * file-preview-modal opener with `mode: "agent-review"` and `reviewId`.
   */
  onOpen?: (reviewId: string, filePath: string) => void;
}

export function AgentReviewCard({
  reviewId,
  filePath,
  findingCount,
  summary,
  onOpen,
}: AgentReviewCardProps) {
  const handleOpen = () => {
    if (onOpen) onOpen(reviewId, filePath);
  };

  const findingLabel =
    findingCount === 0
      ? "no findings"
      : `${findingCount} finding${findingCount === 1 ? "" : "s"}`;

  return (
    <div
      data-testid="agent-review-card"
      className="rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) px-3 py-2.5 text-xs flex flex-col gap-2"
    >
      <div className="flex items-start gap-2">
        <span className="shrink-0 text-(--color-accent) mt-0.5">
          <MagnifyingGlassIcon size={ICON_SIZE.SM} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-(--color-text-tertiary) text-[10px] uppercase tracking-wide font-medium">
            Agent review
          </div>
          <div className="text-(--color-text-primary) font-medium truncate" title={filePath}>
            {filePath}
          </div>
          <div className="mt-1 text-(--color-text-tertiary) text-[11px]">
            {findingLabel}
          </div>
          {summary && (
            <div className="mt-1 text-(--color-text-secondary) text-[11px] italic">
              “{summary}”
            </div>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleOpen}
          disabled={!onOpen}
          className="shrink-0 gap-1"
          aria-label={`Open agent review of ${filePath}`}
        >
          <ArrowSquareOutIcon size={ICON_SIZE.XS} />
          Open
        </Button>
      </div>
    </div>
  );
}
