import { useSessionStore } from "../../../stores/session-store.js";
import type { PrCardState } from "../../../stores/pr-store.js";
import { Button } from "../../ui/button.js";
import { CircleNotchIcon } from "@phosphor-icons/react";
import { PrStateBadge } from "../PrStateBadge.js";
import { DiffStats, SessionTitleLabel, PreviouslyMergedNote, useOpenPrDiff } from "../shared.js";

// Note: the global "Auto-create PR after every meaningful turn" toggle was
// previously rendered here in an overflow menu. It moved to Settings → GitHub
// because the ready-phase card only appears for sessions without a PR (and is
// transient when auto-create is on), which made the toggle effectively
// undiscoverable. See docs/099-auto-pr-on-meaningful-turn/plan.md.

export function ReadyPhase({
  card,
  sessionId,
  creating: externalCreating,
  onCreatePr,
}: {
  card: PrCardState;
  sessionId: string;
  creating?: boolean;
  onCreatePr?: () => void;
}) {
  const prCreationTurnRunning = useSessionStore((s) => s.isLoading && s.activity?.label === "Creating PR...");
  const creating = Boolean(externalCreating) || prCreationTurnRunning;
  const ins = card.totalInsertions ?? 0;
  const del = card.totalDeletions ?? 0;
  const hasDiffStats = ins > 0 || del > 0;
  const openDiff = useOpenPrDiff();

  return (
    <div className="flex items-center gap-3 flex-nowrap min-w-0 flex-1">
      <PrStateBadge sessionId={sessionId} />
      <SessionTitleLabel sessionId={sessionId} />
      {card.previousMergedPr && (
        <PreviouslyMergedNote previousMergedPr={card.previousMergedPr} withReady />
      )}
      <span className="ml-auto shrink-0 flex items-center gap-3">
        {hasDiffStats && <DiffStats ins={ins} del={del} onClick={openDiff} />}
        {hasDiffStats && (
          <Button
            size="md"
            onClick={onCreatePr}
            disabled={creating || !onCreatePr}
            className="shrink-0 bg-(--color-success) hover:bg-(--color-success) hover:opacity-90 text-(--color-text-inverse)"
          >
            {creating && <CircleNotchIcon size={14} className="animate-spin" />}
            {creating ? "Creating PR..." : "Create PR"}
          </Button>
        )}
      </span>
    </div>
  );
}
