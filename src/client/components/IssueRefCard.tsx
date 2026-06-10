/**
 * IssueRefCard — inline read-only navigation card for an agent issue view
 * (docs/188).
 *
 * Rendered at the chat position where the agent ran `shipit issue view`. It is
 * the read-path sibling of `IssueWriteCard`: any agent issue interaction — not
 * just edits — leaves a quick jump-to-issue affordance in the transcript. Unlike
 * the write card it has NO lifecycle (no undo), so the full payload arrives on
 * the chat message and the component renders straight from props — no store.
 *
 * docs/189 — clicking the card opens ShipIt's inline single-issue view (the
 * Issues tab's detail pane), NOT the external tracker. The deep link to Linear/
 * GitHub now lives only inside that view (CLAUDE.md §2: inline beats link-out).
 */

import { CaretRightIcon, EyeIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import type { IssueRefCard as IssueRefCardData } from "../../server/shared/types.js";

export interface IssueRefCardProps {
  card: IssueRefCardData;
  /** Open the inline detail view for this issue (docs/189). */
  onOpen?: (ref: { tracker: IssueRefCardData["tracker"]; identifier: string; title?: string; url?: string }) => void;
}

/** A done issue (closed / completed / canceled) reads as muted, not active. */
function isDone(statusType?: string): boolean {
  return statusType === "completed" || statusType === "canceled";
}

export function IssueRefCard({ card, onOpen }: IssueRefCardProps) {
  const done = isDone(card.statusType);

  const open = () =>
    onOpen?.({
      tracker: card.tracker,
      identifier: card.identifier,
      ...(card.title ? { title: card.title } : {}),
      ...(card.url ? { url: card.url } : {}),
    });

  return (
    <button
      type="button"
      data-testid="issue-ref-card"
      onClick={open}
      title={`Open ${card.identifier} in ShipIt`}
      className="w-full text-left rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) px-3 py-2.5 text-xs flex items-center gap-2 cursor-pointer hover:bg-(--color-bg-hover) hover:border-(--color-border-primary) transition-colors group"
    >
      <span className="shrink-0 text-(--color-text-tertiary)">
        <EyeIcon size={ICON_SIZE.SM} />
      </span>

      <div className="min-w-0 flex-1 text-(--color-text-primary)">
        <span className="text-(--color-text-tertiary)">Agent viewed</span>{" "}
        <span className="font-medium">{card.identifier}</span>
        {card.title && (
          <>
            {" — "}
            <span className="text-(--color-text-secondary)">{card.title}</span>
          </>
        )}
        {card.status && (
          <span className={done ? "text-(--color-text-tertiary)" : "text-(--color-text-secondary)"}>
            {" · "}
            {card.status}
          </span>
        )}
      </div>

      <CaretRightIcon
        size={ICON_SIZE.SM}
        className="shrink-0 text-(--color-text-tertiary) group-hover:text-(--color-text-secondary) transition-colors"
      />
    </button>
  );
}
