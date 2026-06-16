import type { PrCardState } from "../../../stores/pr-store.js";
import { PrStateBadge } from "../PrStateBadge.js";
import { DiffStats, linkClass, useOpenPrDiff } from "../shared.js";

export function TerminalPhase({ card, sessionId, text }: { card: PrCardState; sessionId: string; text: string }) {
  const pr = card.pr;
  const openDiff = useOpenPrDiff(pr?.baseBranch);
  const hasDiffStats = pr && (pr.insertions > 0 || pr.deletions > 0);
  return (
    <div className="flex items-center gap-3 flex-nowrap min-w-0 flex-1">
      <PrStateBadge sessionId={sessionId} url={pr?.url} prNumber={pr?.number} />
      <span className="h-6 flex items-center text-xs text-(--color-text-secondary) truncate min-w-0">{text}</span>
      {pr && (
        <span className="ml-auto shrink-0">
          {hasDiffStats
            ? <DiffStats ins={pr.insertions} del={pr.deletions} onClick={openDiff} />
            : <button onClick={openDiff} className={`${linkClass} shrink-0 cursor-pointer hover:text-(--color-text-secondary)`} title="View full diff">Diff</button>
          }
        </span>
      )}
    </div>
  );
}
