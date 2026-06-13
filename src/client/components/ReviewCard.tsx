/**
 * ReviewCard — inline chat affordance for a plain-text AI review (docs/203).
 *
 * Rendered at the chat-history position where the parent's `submit_review` call
 * landed. Read-only and self-contained: a collapsible header (file + reviewer
 * label + timestamp) over the reviewer's markdown findings, which render with
 * the same `path:line`-linkifying markdown renderer as chat messages so a
 * finding's location is clickable. No line anchoring, no snapshot, no modal.
 *
 * Replaces the docs/151 `AgentReviewCard`. A degraded `legacy` card (mapped from
 * a pre-docs/203 `agent_review` row that has no markdown) shows file + finding
 * count + a "Reviewed earlier" note instead of markdown.
 */

import { useState } from "react";
import { CaretDownIcon, MagnifyingGlassIcon, CheckCircleIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { MarkdownContent } from "./message-markdown.js";
import type { AiReviewCard } from "../../server/shared/types.js";

const CLEAN_REVIEW = /^no material issues found\.?$/i;

export function ReviewCard({ card }: { card: AiReviewCard }) {
  const [collapsed, setCollapsed] = useState(false);

  const time = (() => {
    const d = new Date(card.createdAt);
    return Number.isNaN(d.getTime())
      ? ""
      : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  })();

  const isClean = !card.legacy && CLEAN_REVIEW.test(card.markdown.trim());

  const metaParts = [
    card.legacy
      ? `${card.findingCount ?? 0} finding${card.findingCount === 1 ? "" : "s"}`
      : null,
    card.reReviewed ? "re-reviewed" : null,
    time || null,
  ].filter(Boolean) as string[];

  return (
    <div
      data-testid="ai-review-card"
      className="rounded-xl border border-(--color-border-secondary) bg-(--color-bg-secondary) overflow-hidden text-xs"
    >
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex items-center gap-2.5 w-full px-3 py-2.5 text-left cursor-pointer hover:bg-(--color-bg-hover) transition-colors"
        aria-expanded={!collapsed}
      >
        <span className="shrink-0 grid place-items-center w-6 h-6 rounded-md bg-(--color-accent-subtle) text-(--color-accent)">
          <MagnifyingGlassIcon size={ICON_SIZE.SM} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-(--color-text-primary) font-medium">Review</span>
          <span className="block text-(--color-text-tertiary) text-[11px] truncate" title={card.filePath}>
            <span className="font-mono text-(--color-text-secondary)">{card.filePath}</span>
            {metaParts.length > 0 && ` · ${metaParts.join(" · ")}`}
          </span>
        </span>
        <span className="shrink-0 rounded-full border border-(--color-border-secondary) bg-(--color-accent-subtle) text-(--color-accent) px-2 py-0.5 text-[11px]">
          {card.reviewerLabel}
        </span>
        <CaretDownIcon
          size={ICON_SIZE.SM}
          className={`shrink-0 text-(--color-text-tertiary) transition-transform ${collapsed ? "-rotate-90" : ""}`}
        />
      </button>

      {!collapsed && (
        <div className="border-t border-(--color-border-secondary) px-4 py-3">
          {card.legacy ? (
            <p className="text-(--color-text-secondary)">
              Reviewed earlier. The anchored details from this review are no longer shown.
            </p>
          ) : isClean ? (
            <div className="flex items-center gap-2 text-(--color-text-secondary)">
              <span className="text-(--color-success)">
                <CheckCircleIcon size={ICON_SIZE.SM} />
              </span>
              No material issues found.
            </div>
          ) : (
            <MarkdownContent text={card.markdown} />
          )}
        </div>
      )}
    </div>
  );
}
