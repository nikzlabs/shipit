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
  PencilSimpleIcon,
  CheckIcon,
  XIcon,
} from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";
import { usePrStore, type PrCardState } from "../../stores/pr-store.js";
import { Banner } from "../ui/banner.js";

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

function formatRelativeDate(dateStr: string): string {
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return "";
  const diffMin = Math.floor((Date.now() - date.getTime()) / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

export function PrDetailHeader({
  card,
  sessionId,
}: {
  card: PrCardState;
  sessionId: string;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pr = card.pr;
  if (!pr) return null;

  const editable = card.phase === "open";

  const startEditing = () => {
    setDraft(pr.title);
    setError(null);
    setEditingTitle(true);
  };

  const cancel = () => {
    setEditingTitle(false);
    setError(null);
  };

  const save = async () => {
    const title = draft.trim();
    if (submitting) return;
    if (!title) {
      setError("Title cannot be empty");
      return;
    }
    if (title === pr.title) {
      cancel();
      return;
    }
    setSubmitting(true);
    setError(null);
    const err = await usePrStore.getState().updatePr(sessionId, { title });
    setSubmitting(false);
    if (err) {
      setError(err);
      return;
    }
    setEditingTitle(false);
  };

  return (
    <div className="border-b border-(--color-border-primary) px-4 py-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <StateBadge phase={card.phase} />
            <span className="text-(--color-text-tertiary) text-sm font-mono">#{pr.number}</span>
          </div>
          {editingTitle ? (
            <div className="mt-1.5 flex flex-col gap-2">
              <div className="flex items-center gap-1.5">
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void save();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      cancel();
                    }
                  }}
                  disabled={submitting}
                  autoFocus
                  aria-label="PR title"
                  className="min-w-0 flex-1 rounded-md border border-(--color-border-secondary) bg-(--color-bg-secondary) px-2 py-1 text-base font-semibold text-(--color-text-primary) focus:border-(--color-border-focus) focus:outline-none disabled:opacity-50"
                />
                <button
                  onClick={() => void save()}
                  disabled={submitting}
                  aria-label="Save title"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-(--color-success) hover:bg-(--color-bg-hover) transition-colors disabled:opacity-50"
                >
                  <CheckIcon size={ICON_SIZE.SM} weight="bold" />
                </button>
                <button
                  onClick={cancel}
                  disabled={submitting}
                  aria-label="Cancel title edit"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-(--color-text-tertiary) hover:text-(--color-text-secondary) hover:bg-(--color-bg-hover) transition-colors disabled:opacity-50"
                >
                  <XIcon size={ICON_SIZE.SM} weight="bold" />
                </button>
              </div>
              {error && (
                <Banner variant="error" className="rounded-md text-left">
                  {error}
                </Banner>
              )}
            </div>
          ) : (
            <div className="mt-1.5 flex items-start gap-1.5">
              <h2 className="min-w-0 flex-1 text-base font-semibold text-(--color-text-primary) wrap-break-word">
                {pr.title}
              </h2>
              {editable && (
                <button
                  onClick={startEditing}
                  aria-label="Edit title"
                  className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded text-(--color-text-tertiary) hover:text-(--color-text-secondary) hover:bg-(--color-bg-hover) transition-colors"
                >
                  <PencilSimpleIcon size={ICON_SIZE.SM} />
                </button>
              )}
            </div>
          )}
          <div className="mt-1 flex items-center gap-2 text-xs text-(--color-text-tertiary) flex-wrap">
            {pr.author && (
              <>
                {pr.author.avatarUrl ? (
                  <img
                    src={pr.author.avatarUrl}
                    alt=""
                    className="h-4 w-4 rounded-full border border-(--color-border-secondary)"
                  />
                ) : null}
                <span>@{pr.author.login}</span>
                <span>·</span>
              </>
            )}
            {pr.createdAt && (
              <>
                <span title={new Date(pr.createdAt).toLocaleString()}>
                  opened {formatRelativeDate(pr.createdAt)}
                </span>
                <span>·</span>
              </>
            )}
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
