/**
 * PrDetailHeader — title, PR number, branch routing, diff stats, and an
 * overflow menu for secondary actions (the "View on GitHub" escape hatch).
 *
 * Reads from the same store slice as the inline card (pr-store), so the card
 * and panel never drift. Per docs/133, the "View on GitHub" link is demoted
 * to an overflow menu — inline rendering is the primary surface.
 */

import { useState } from "react";
import {
  GitPullRequestIcon,
  GitMergeIcon,
  GitBranchIcon,
  ArrowSquareOutIcon,
  DotsThreeVerticalIcon,
} from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";
import type { PrCardState } from "../../stores/pr-store.js";

function StateBadge({ phase }: { phase: PrCardState["phase"] }) {
  const base = "inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium border";
  if (phase === "merged") {
    return (
      <span className={`${base} bg-(--color-pr-subtle) text-(--color-pr) border-(--color-pr-border)`}>
        <GitMergeIcon size={ICON_SIZE.XS} /> Merged
      </span>
    );
  }
  if (phase === "closed") {
    return (
      <span className={`${base} bg-(--color-bg-tertiary) text-(--color-text-tertiary) border-(--color-border-secondary)`}>
        <GitBranchIcon size={ICON_SIZE.XS} /> Closed
      </span>
    );
  }
  return (
    <span className={`${base} bg-(--color-success-subtle) text-(--color-success) border-(--color-success-border)`}>
      <GitPullRequestIcon size={ICON_SIZE.XS} /> Open
    </span>
  );
}

export function PrDetailHeader({ card }: { card: PrCardState }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const pr = card.pr;
  if (!pr) return null;

  return (
    <div className="border-b border-(--color-border-primary) px-4 py-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <StateBadge phase={card.phase} />
            <span className="text-(--color-text-tertiary) text-sm font-mono">#{pr.number}</span>
          </div>
          <h2 className="mt-1.5 text-base font-semibold text-(--color-text-primary) wrap-break-word">
            {pr.title}
          </h2>
          <div className="mt-1 flex items-center gap-2 text-xs text-(--color-text-tertiary) flex-wrap">
            <span className="font-mono">{pr.baseBranch}</span>
            <span>←</span>
            <span className="font-mono">{pr.headBranch}</span>
            <span>·</span>
            <span>
              <span className="text-(--color-success)">+{pr.insertions}</span>{" "}
              <span className="text-(--color-error)">-{pr.deletions}</span>
            </span>
          </div>
        </div>
        <div className="relative shrink-0">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="h-7 w-7 flex items-center justify-center rounded text-(--color-text-tertiary) hover:text-(--color-text-secondary) hover:bg-(--color-bg-hover) transition-colors"
            aria-label="More options"
          >
            <DotsThreeVerticalIcon size={ICON_SIZE.SM} weight="bold" />
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 top-full mt-1 z-50 bg-(--color-bg-elevated) border border-(--color-border-secondary) rounded-lg shadow-xl py-1 min-w-44">
                <a
                  href={pr.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setMenuOpen(false)}
                  className="flex items-center gap-2 px-3 py-1.5 text-xs text-(--color-text-secondary) hover:bg-(--color-bg-hover) transition-colors"
                >
                  <ArrowSquareOutIcon size={ICON_SIZE.SM} /> View on GitHub
                </a>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
