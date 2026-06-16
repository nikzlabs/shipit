/**
 * Shared primitives for the PR lifecycle card — small presentational pieces and
 * the diff-open hook reused across the phase renderers (ready/open/terminal).
 */

import { useCallback } from "react";
import { useGitStore } from "../../stores/git-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { PrCardState } from "../../stores/pr-store.js";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "../ui/tooltip.js";
import { MarkdownContent } from "../message-markdown.js";
import { GitMergeIcon, CircleNotchIcon } from "@phosphor-icons/react";

// NB: block-level `flex` (not `inline-flex`) so the chip renders at exactly
// h-6 regardless of its parent. As an inline-flex element it would be
// baseline-aligned inside a non-flex parent's line box, rounding the line up
// to 25px and making any containing row 1px taller (the merged PR card bug).
export const linkClass = "h-6 flex items-center gap-1 text-xs text-(--color-text-tertiary) hover:text-(--color-text-secondary) transition-colors border border-(--color-border-secondary) rounded px-1.5";
export const MAX_VISIBLE_FAILURES = 5;

const DEFAULT_BRANCHES = new Set(["main", "master"]);
export function isDefaultBranch(branch: string): boolean {
  return DEFAULT_BRANCHES.has(branch);
}

export function Spinner() {
  return (
    <CircleNotchIcon size={14} className="animate-spin text-(--color-info) shrink-0" />
  );
}

export function DiffStats({ ins, del, onClick }: { ins: number; del: number; onClick?: () => void }) {
  const content = (
    <>
      <span className="text-(--color-success)">+{ins}</span>
      <span className="text-(--color-error)">-{del}</span>
    </>
  );
  if (!onClick) {
    return <span className={`${linkClass} shrink-0`}>{content}</span>;
  }
  return (
    <button onClick={onClick} className={`${linkClass} shrink-0 cursor-pointer hover:text-(--color-text-secondary)`} title="View full diff">
      {content}
    </button>
  );
}

/** Fetch diff of HEAD vs a base branch and open it in the diff dialog. */
export function useOpenPrDiff(baseBranch?: string) {
  const sessionId = useSessionStore((s) => s.sessionId);
  return useCallback(async () => {
    if (!sessionId) return;
    const base = baseBranch || "main";
    try {
      await useGitStore.getState().fetchDiffVsBranch(sessionId, base);
      useGitStore.getState().openDiffDialog(`Changes vs ${base}`);
    } catch {
      // Silently fail
    }
  }, [sessionId, baseBranch]);
}

/**
 * PR title (with rich-tooltip PR body) for the open phase. The branch name
 * itself is no longer surfaced here — pre-PR it's replaced by the session
 * title in ReadyPhase, and the copy affordance has moved to the overflow
 * menu's "Copy branch name" item.
 *
 * Rendering rules:
 *   - `prTitle` unset, non-default base → "base ← head".
 *   - `prTitle` unset, default base     → just `headBranch`.
 *   - `prTitle` set                     → render `prTitle`; tooltip shows
 *                                          full `prBody` as markdown (or a
 *                                          fallback when there's no body).
 */
export function BranchLabel({
  baseBranch,
  headBranch,
  prTitle,
  prBody,
}: {
  baseBranch?: string;
  headBranch?: string;
  prTitle?: string;
  prBody?: string;
}) {
  if (!headBranch && !prTitle) return null;

  const labelClass =
    "h-6 text-xs flex items-center gap-1 min-w-0 overflow-hidden text-(--color-text-secondary)";

  if (!prTitle) {
    const content = baseBranch && !isDefaultBranch(baseBranch) ? (
      <>{baseBranch} <span className="text-(--color-text-tertiary)">←</span> {headBranch}</>
    ) : headBranch;
    return (
      <span className={labelClass}>
        <span className="truncate">{content}</span>
      </span>
    );
  }

  const trimmedBody = (prBody ?? "").trim();

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={labelClass}>
            <span className="truncate">{prTitle}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent
          side="bottom"
          className="max-w-lg max-h-96 flex flex-col overflow-hidden text-left p-0"
        >
          <div className="flex-1 min-h-0 overflow-auto p-3">
            {trimmedBody.length > 0 ? (
              <MarkdownContent text={trimmedBody} />
            ) : (
              <div className="text-(--color-text-primary)">No description</div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * Pre-PR label: shows what the user asked for, not the synthetic branch slug.
 *
 * Resolution order:
 *  1. The session title. `graduateSession` sets it to a snippet of the first
 *     user message immediately, and an AI rename replaces it with a tidy
 *     phrase a few seconds later — both are user-meaningful.
 *  2. If the title is still the pre-graduation placeholder ("New session") or
 *     somehow empty, fall back to the first user message from chat history so
 *     we show *something the user typed* rather than nothing.
 *
 * We deliberately never fall back to the branch slug — `shipit/pf_7ol` reads
 * as noise to the user and would be inconsistent with the post-PR view, which
 * shows the PR title.
 */
export function SessionTitleLabel({ sessionId }: { sessionId: string }) {
  const title = useSessionStore((s) => s.sessions.find((sess) => sess.id === sessionId)?.title);
  const firstUserText = useSessionStore((s) => s.messages.find((m) => m.role === "user")?.text);
  const trimmedTitle = title?.trim() ?? "";
  const isPlaceholder = !trimmedTitle || trimmedTitle === "New session";
  const text = isPlaceholder ? firstUserText?.trim() : trimmedTitle;
  if (!text) return null;
  return (
    <span className="h-6 text-xs flex items-center gap-1 min-w-0 overflow-hidden text-(--color-text-secondary)">
      <span className="truncate">{text}</span>
    </span>
  );
}

/**
 * docs/202 — subtle "previously merged #N" breadcrumb for a re-armed session
 * (it shipped a PR, then the branch was rebased + progressed and ShipIt dropped
 * the merged state). The session's status indicator is gray like a fresh
 * session; this note is the only sign it shipped once. `withReady` appends the
 * "· ready for a new PR" hint used on the ready card.
 */
export function PreviouslyMergedNote({
  previousMergedPr,
  withReady,
}: {
  previousMergedPr: NonNullable<PrCardState["previousMergedPr"]>;
  withReady?: boolean;
}) {
  const label = (
    <>
      <GitMergeIcon size={12} className="shrink-0" />
      Previously merged #{previousMergedPr.number}
      {withReady && " · ready for a new PR"}
    </>
  );
  const className = "h-6 text-xs flex items-center gap-1 shrink-0 text-(--color-text-tertiary)";
  if (previousMergedPr.url) {
    return (
      <a
        href={previousMergedPr.url}
        target="_blank"
        rel="noopener noreferrer"
        className={`${className} hover:text-(--color-text-secondary) transition-colors`}
        title={`Previously merged: ${previousMergedPr.title}`}
      >
        {label}
      </a>
    );
  }
  return (
    <span className={className} title={`Previously merged: ${previousMergedPr.title}`}>
      {label}
    </span>
  );
}
