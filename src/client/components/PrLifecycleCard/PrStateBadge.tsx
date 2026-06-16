/**
 * PrStateBadge — the small square status badge for a session's PR state.
 * Reused in the sidebar (SessionItem) and across the card's phase renderers.
 */

import { usePrStore } from "../../stores/pr-store.js";
import {
  GitBranchIcon,
  GitPullRequestIcon,
  GitMergeIcon,
} from "@phosphor-icons/react";
import { GitPullRequestClosedIcon } from "../GitPullRequestClosedIcon.js";
import { ICON_SIZE } from "../../design-tokens.js";

export function PrStateBadge({ sessionId, url, prNumber }: { sessionId: string; url?: string; prNumber?: number }) {
  const status = usePrStore((s) => s.statusBySession[sessionId]);
  const card = usePrStore((s) => s.cardBySession[sessionId]);

  const prState = status?.prState ?? (card?.phase === "merged" ? "merged" : card?.phase === "closed" ? "closed" : card?.phase === "open" ? "open" : null);

  const base = "w-5 h-5 rounded-md flex items-center justify-center shrink-0 border";

  let className: string;
  let title: string;
  let icon: React.ReactNode;

  if (prState === "merged") {
    className = `${base} bg-(--color-pr-subtle) text-(--color-pr) border-(--color-pr-border)`;
    title = prNumber ? `PR #${prNumber} merged` : "PR merged";
    icon = <GitMergeIcon size={ICON_SIZE.SM} />;
  } else if (prState === "open") {
    className = `${base} bg-(--color-success-subtle) text-(--color-success) border-(--color-success-border)`;
    title = prNumber ? `PR #${prNumber}` : "PR open";
    icon = <GitPullRequestIcon size={ICON_SIZE.SM} />;
  } else if (prState === "closed") {
    // Closed-but-not-merged: red, mirroring GitHub's convention, so it reads as
    // distinct from both the green open PR and a plain (PR-less) branch.
    className = `${base} bg-(--color-error)/15 text-(--color-error) border-(--color-error)/30`;
    title = prNumber ? `PR #${prNumber} closed` : "PR closed";
    icon = <GitPullRequestClosedIcon size={ICON_SIZE.SM} />;
  } else {
    className = `${base} bg-(--color-bg-tertiary) text-(--color-text-tertiary) border-(--color-border-secondary)`;
    title = "Branch";
    icon = <GitBranchIcon size={ICON_SIZE.SM} />;
  }

  if (url) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className={`${className} hover:opacity-80 transition-opacity`} title={title}>
        {icon}
      </a>
    );
  }
  return <span className={className} title={title}>{icon}</span>;
}
