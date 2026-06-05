/**
 * IssueWriteCard — inline do-then-surface provenance card for an agent issue
 * write (docs/177).
 *
 * Rendered at the chat position where the agent's `shipit issue` write landed.
 * The write has ALREADY happened — this card is the review surface (consistent
 * with how ShipIt treats commits / PR creation, not a per-action gate). It
 * shows what changed, who it's attributed to, and an Undo button that fires a
 * reverse brokered write.
 *
 * Attribution is load-bearing: a GitHub write is the user's own (their token),
 * but a Linear write uses the deployment-wide PAT, so the card must NOT claim
 * the acting user authored it — it attributes Linear writes to the workspace.
 *
 * Lifecycle (from the issue-write store, keyed by cardId): available → undoing
 * → undone | (failed shows the error and re-offers Undo).
 */

import {
  ArrowSquareOutIcon,
  ArrowUUpLeftIcon,
  CheckCircleIcon,
  PencilSimpleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import { useIssueWriteStore } from "../stores/issue-write-store.js";

export interface IssueWriteCardProps {
  cardId: string;
  onUndo?: (cardId: string) => void;
}

export function IssueWriteCard({ cardId, onUndo }: IssueWriteCardProps) {
  const card = useIssueWriteStore((s) => s.cards[cardId]);
  if (!card) return null;

  const undone = card.undoState === "undone";
  const undoing = card.undoState === "undoing";
  const failed = card.undoState === "failed";

  const attribution =
    card.attribution === "user"
      ? "by you"
      : "by the ShipIt agent (workspace token)";

  return (
    <div
      data-testid="issue-write-card"
      className="rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) px-3 py-2.5 text-xs flex items-center gap-2"
    >
      <span className={`shrink-0 ${undone ? "text-(--color-text-tertiary)" : "text-(--color-accent)"}`}>
        {undone ? (
          <CheckCircleIcon size={ICON_SIZE.SM} weight="fill" />
        ) : (
          <PencilSimpleIcon size={ICON_SIZE.SM} />
        )}
      </span>

      <div className="min-w-0 flex-1 text-(--color-text-primary)">
        <span className={undone ? "line-through text-(--color-text-tertiary)" : ""}>
          Agent {card.summary}
        </span>{" "}
        <span className="text-(--color-text-tertiary)">{attribution}</span>
        {undone && <span className="text-(--color-text-tertiary)"> · undone</span>}
        {failed && card.errorMessage && (
          <span className="flex items-start gap-1 mt-1 text-(--color-error)">
            <WarningIcon size={ICON_SIZE.XS} weight="fill" className="mt-0.5 shrink-0" />
            <span>Undo failed: {card.errorMessage}</span>
          </span>
        )}
      </div>

      {card.url && (
        <a
          href={card.url}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 inline-flex items-center gap-1 text-(--color-text-secondary) hover:text-(--color-text-primary)"
        >
          <ArrowSquareOutIcon size={ICON_SIZE.XS} />
          {card.identifier}
        </a>
      )}

      {!undone && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onUndo?.(cardId)}
          disabled={undoing}
          className="shrink-0"
        >
          <ArrowUUpLeftIcon size={ICON_SIZE.XS} />
          {undoing ? "Undoing…" : failed ? "Retry undo" : "Undo"}
        </Button>
      )}
    </div>
  );
}
