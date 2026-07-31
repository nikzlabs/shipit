/**
 * SelfMergeWatchCard — inline record that this session armed a watch on its OWN
 * pull request (docs/239): when PR #N merges, ShipIt wakes the session with a
 * turn and the agent continues the work.
 *
 * One card, at arm time, with one action. There is deliberately NO card
 * lifecycle here — the card does not transition to "merged" or "delivered",
 * because the wake turn appearing in the transcript IS the visible signal, and
 * the terminal failure cases (closed without merging, anchor mismatch, delivery
 * gave up) append plain notes instead.
 *
 * Cancel sends the card's `watchId` back. That is load-bearing rather than
 * defensive: a multi-PR chain re-arms after each merge, so an older card from an
 * earlier link is still sitting in the scrollback naming a watch that no longer
 * exists. Without the id, clicking its Cancel would silently cancel the CURRENT
 * PR's watch. A stale click is reported as "no longer armed", not an error.
 *
 * Cancelling means no wake fires, so no turn runs, so nothing re-arms — but a
 * turn already in flight finishes and may re-arm, which the copy says outright
 * rather than implying a guarantee the design doesn't make.
 */

import { useState } from "react";
import { BellRingingIcon, GitBranchIcon, GitPullRequestIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import { useApi } from "../hooks/useApi.js";
import type { SelfMergeWatchCard as SelfMergeWatchCardData } from "../../server/shared/types.js";

export interface SelfMergeWatchCardProps {
  card: SelfMergeWatchCardData;
  /** The session that owns this transcript — the cancel target. */
  sessionId: string;
}

type CancelState =
  | { phase: "idle" }
  | { phase: "cancelling" }
  | { phase: "cancelled" }
  /** The watch this card names is gone — superseded by a re-arm, or never armed. */
  | { phase: "stale" }
  | { phase: "failed"; error: string };

export function SelfMergeWatchCard({ card, sessionId }: SelfMergeWatchCardProps) {
  const api = useApi();
  const [state, setState] = useState<CancelState>({ phase: "idle" });

  const handleCancel = async () => {
    setState({ phase: "cancelling" });
    try {
      const res = await api.post<{ cancelled: boolean; reason?: string }>(
        `/api/sessions/${sessionId}/notify-on-merge-self/cancel`,
        { watchId: card.watchId },
      );
      setState(res.cancelled ? { phase: "cancelled" } : { phase: "stale" });
    } catch (err) {
      setState({ phase: "failed", error: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div
      data-testid="self-merge-watch-card"
      data-phase={state.phase}
      className="rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) px-3 py-2.5 text-xs flex flex-col gap-2"
    >
      <div className="flex items-start gap-2">
        <span className="shrink-0 mt-0.5 text-(--color-accent)">
          <BellRingingIcon size={ICON_SIZE.SM} weight="fill" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-(--color-text-tertiary) text-[10px] uppercase tracking-wide font-medium">
            Will continue when this PR merges
          </div>
          <div className="text-(--color-text-primary) font-medium">
            Waiting on PR #{card.prNumber}
          </div>
          {card.branch && (
            <div className="mt-1 flex items-center gap-1 text-(--color-text-tertiary) text-[11px]">
              <GitBranchIcon size={ICON_SIZE.XS} className="shrink-0" />
              <span className="truncate font-mono" title={card.branch}>{card.branch}</span>
            </div>
          )}
        </div>
        {state.phase === "idle" || state.phase === "failed" ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void handleCancel()}
            className="shrink-0"
            aria-label={`Cancel the merge watch on PR #${card.prNumber}`}
          >
            Cancel
          </Button>
        ) : null}
      </div>

      <a
        href={card.prUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1.5 rounded border border-(--color-border-secondary) bg-(--color-bg-primary) px-2 py-1.5 text-[11px] text-(--color-text-secondary) hover:text-(--color-text-primary)"
        title={card.prTitle}
      >
        <GitPullRequestIcon size={ICON_SIZE.XS} className="shrink-0" />
        <span className="font-mono shrink-0">#{card.prNumber}</span>
        {card.prTitle && <span className="truncate">{card.prTitle}</span>}
      </a>

      <div className="text-[11px] text-(--color-text-tertiary)">
        {state.phase === "cancelled"
          ? "Cancelled — this session will not be woken when the PR merges. A turn already running "
            + "will still finish, and may arm a new watch."
          : state.phase === "stale"
            ? "No longer armed — this watch was replaced or already cancelled."
            : state.phase === "failed"
              ? `Couldn't cancel: ${state.error}`
              : "On merge, the agent resets this branch to the latest base and continues the work. "
                + "Cancel to stop that."}
      </div>
    </div>
  );
}
