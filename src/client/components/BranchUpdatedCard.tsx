/**
 * BranchUpdatedCard — inline record that a merged session's branch was
 * automatically reset to the latest base before the turn ran (docs/218).
 *
 * Rendered right after the user's message (and before the agent's response) when
 * the pre-turn auto-reset fired. A destructive automatic op must not happen
 * silently, so this is the user-facing signal of record: it states the move and
 * shows the concrete `was → now` SHAs for auditability. The card has NO lifecycle
 * (no undo) — the merged change IS the permanent record — so the full payload
 * arrives on the chat message and the component renders straight from props (no
 * store). Per CLAUDE.md §2 (inline beats link-out) the PR number is plain text,
 * not a GitHub link.
 */

import { GitBranchIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import type { BranchAutoResetCard as BranchAutoResetCardData } from "../../server/shared/types.js";

export interface BranchUpdatedCardProps {
  card: BranchAutoResetCardData;
}

/** Short, git-style 7-char SHA. */
function short(sha: string): string {
  return sha.slice(0, 7);
}

export function BranchUpdatedCard({ card }: BranchUpdatedCardProps) {
  return (
    <div
      data-testid="branch-updated-card"
      className="w-full rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) overflow-hidden text-xs"
    >
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <span className="shrink-0 mt-0.5 grid place-items-center w-7 h-7 rounded-lg bg-(--color-accent-subtle) text-(--color-accent) border border-(--color-border-secondary)">
          <GitBranchIcon size={ICON_SIZE.SM} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-medium text-(--color-text-primary)">
            Branch {card.forced ? "force-reset" : "updated"} to latest{" "}
            <code className="px-1.5 py-0.5 rounded bg-(--color-bg-tertiary)">{card.base}</code>
          </div>
          {/* SHI-277 — a forced reset skipped the "this branch is exactly what
              merged" safety check, so it must not read as the routine automatic
              move. The recorded reason is the whole accountability story for a
              trust-based override, so it is shown, not tucked away. */}
          {card.forced ? (
            <div className="mt-1 text-(--color-text-secondary)">
              This branch was reset to the latest{" "}
              <code className="px-1.5 py-0.5 rounded bg-(--color-bg-tertiary)">{card.base}</code> with{" "}
              <span className="font-medium text-(--color-text-primary)">--force</span>, overriding the check that the
              branch carries nothing beyond merged PR #{card.prNumber}.
              {card.forceReason ? (
                <span className="block mt-1 italic">Reason given: {card.forceReason}</span>
              ) : null}
            </div>
          ) : (
            <div className="mt-1 text-(--color-text-secondary)">
              Your previous PR #{card.prNumber} merged, so this branch was automatically reset to the latest{" "}
              <code className="px-1.5 py-0.5 rounded bg-(--color-bg-tertiary)">{card.base}</code> before continuing.
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3 px-3 pb-2.5 pl-[3.25rem] text-(--color-text-tertiary)">
        <span>
          <span>was </span>
          <span className="font-mono">{short(card.fromSha)}</span>
        </span>
        <span aria-hidden>→</span>
        <span>
          <span>now </span>
          <span className="font-mono">{short(card.toSha)}</span>{" "}
          <span className="text-(--color-text-tertiary)">(origin/{card.base})</span>
        </span>
      </div>
    </div>
  );
}
