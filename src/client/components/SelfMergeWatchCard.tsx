/**
 * The card of one `shipit session notify-on-merge --self` arming (docs/239).
 *
 * Cancel sends the card's own `watchId`. That is load-bearing: a card stored before `ended`
 * existed can still name a watch that is gone, and without the id its Cancel would cancel the
 * CURRENT PR's watch. A stale click is reported as "no longer armed", not as an error.
 */

import { useState } from "react";
import {
  BellRingingIcon,
  BellSlashIcon,
  GitBranchIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import { useApi } from "../hooks/useApi.js";
import type {
  SelfMergeWatchCard as SelfMergeWatchCardData,
  SelfMergeWatchEnd,
} from "../../server/shared/types.js";

export interface SelfMergeWatchCardProps {
  card: SelfMergeWatchCardData;

  sessionId: string;
}

type CancelState =
  | { phase: "idle" }
  | { phase: "cancelling" }
  | { phase: "cancelled" }
  /** The watch this card names is gone — superseded by a re-arm, or never armed. */
  | { phase: "stale" }
  | { phase: "failed"; error: string };

const CANCELLED_TEXT = "Cancelled — this session will not be woken when the PR merges. A turn already "
  + "running will still finish, and may arm a new watch.";

const END_COPY: Record<SelfMergeWatchEnd, { label: string; text: string }> = {
  // Written when the merge is observed, before the wake turn runs; `wake-failed` replaces it.
  merged: {
    label: "This PR merged",
    text: "The PR merged. ShipIt wakes this session to continue the work.",
  },
  closed: {
    label: "PR closed — not merged",
    text: "The PR was closed without merging, so this session was not woken.",
  },
  cancelled: { label: "Merge watch cancelled", text: CANCELLED_TEXT },
  replaced: {
    label: "Merge watch replaced",
    text: "A newer watch replaced this one. This card's watch will not wake the session.",
  },
  "other-pr-merged": {
    label: "Merge watch cleared",
    text: "A different PR merged first, so this watch was cleared and the session was not woken.",
  },
  "wake-failed": {
    label: "Couldn't continue after the merge",
    text: "The PR merged, but ShipIt could not wake this session. Send a message to continue.",
  },
};

function EndIcon({ ended }: { ended: SelfMergeWatchEnd }) {
  if (ended === "merged") return <GitMergeIcon size={ICON_SIZE.SM} weight="fill" />;
  if (ended === "wake-failed") return <WarningIcon size={ICON_SIZE.SM} weight="fill" />;
  return <BellSlashIcon size={ICON_SIZE.SM} weight="fill" />;
}

function endTone(ended: SelfMergeWatchEnd): string {
  if (ended === "merged") return "text-(--color-success)";
  if (ended === "wake-failed" || ended === "closed") return "text-(--color-warning)";
  return "text-(--color-text-tertiary)";
}

export function SelfMergeWatchCard({ card, sessionId }: SelfMergeWatchCardProps) {
  const api = useApi();
  const [state, setState] = useState<CancelState>({ phase: "idle" });
  const ended = card.ended;
  const end = ended ? END_COPY[ended] : undefined;

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
      {...(ended ? { "data-ended": ended } : {})}
      className="rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) px-3 py-2.5 text-xs flex flex-col gap-2"
    >
      <div className="flex items-start gap-2">
        <span className={`shrink-0 mt-0.5 ${ended ? endTone(ended) : "text-(--color-accent)"}`}>
          {ended ? <EndIcon ended={ended} /> : <BellRingingIcon size={ICON_SIZE.SM} weight="fill" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-(--color-text-tertiary) text-[10px] uppercase tracking-wide font-medium">
            {end ? end.label : "Will continue when this PR merges"}
          </div>
          <div className="text-(--color-text-primary) font-medium">
            {end ? `PR #${card.prNumber}` : `Waiting on PR #${card.prNumber}`}
          </div>
          {card.branch && (
            <div className="mt-1 flex items-center gap-1 text-(--color-text-tertiary) text-[11px]">
              <GitBranchIcon size={ICON_SIZE.XS} className="shrink-0" />
              <span className="truncate font-mono" title={card.branch}>{card.branch}</span>
            </div>
          )}
        </div>
        {!end && (state.phase === "idle" || state.phase === "failed") ? (
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
        {end
          ? end.text
          : state.phase === "cancelled"
            ? CANCELLED_TEXT
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
