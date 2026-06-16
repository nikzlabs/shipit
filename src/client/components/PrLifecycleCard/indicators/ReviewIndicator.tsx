import type { PrReviewDecision } from "../../../../server/shared/types.js";
import { XCircleIcon, SealCheckIcon, EyeIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../../design-tokens.js";

/**
 * docs/174 — GitHub review/approval status. Renders nothing for "none" (the
 * base branch requires no review — the common solo-repo case), so the card
 * looks identical to before for unprotected repos. The other three states
 * explain the merge button's presence/absence inline, without a GitHub tab.
 */
export function ReviewIndicator({ reviewDecision }: { reviewDecision: PrReviewDecision | undefined }) {
  if (!reviewDecision || reviewDecision === "none") return null;

  if (reviewDecision === "approved") {
    return (
      <span className="h-6 text-(--color-success) text-xs flex items-center gap-1 shrink-0" title="PR approved">
        <SealCheckIcon size={ICON_SIZE.SM} /> Approved
      </span>
    );
  }
  if (reviewDecision === "changes_requested") {
    return (
      <span className="h-6 text-(--color-error) text-xs flex items-center gap-1 shrink-0" title="A reviewer requested changes">
        <XCircleIcon size={ICON_SIZE.SM} /> Changes requested
      </span>
    );
  }
  // review_required
  return (
    <span className="h-6 text-(--color-warning) text-xs flex items-center gap-1 shrink-0" title="This branch requires a review before merging">
      <EyeIcon size={ICON_SIZE.SM} /> Review required
    </span>
  );
}
