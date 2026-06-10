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
 * The deep link is an escape hatch (ShipIt has no inline single-issue view yet),
 * consistent with how the Issues tab and the write card link out per-issue.
 */

import { ArrowSquareOutIcon, EyeIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import type { IssueRefCard as IssueRefCardData } from "../../server/shared/types.js";

export interface IssueRefCardProps {
  card: IssueRefCardData;
}

/** A done issue (closed / completed / canceled) reads as muted, not active. */
function isDone(statusType?: string): boolean {
  return statusType === "completed" || statusType === "canceled";
}

export function IssueRefCard({ card }: IssueRefCardProps) {
  const done = isDone(card.statusType);

  return (
    <div
      data-testid="issue-ref-card"
      className="rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) px-3 py-2.5 text-xs flex items-center gap-2"
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

      {card.url && (
        <a
          href={card.url}
          target="_blank"
          rel="noreferrer"
          title={`Open ${card.identifier} in the tracker`}
          className="shrink-0 inline-flex items-center gap-1 text-(--color-text-secondary) hover:text-(--color-text-primary)"
        >
          <ArrowSquareOutIcon size={ICON_SIZE.XS} />
          {card.identifier}
        </a>
      )}
    </div>
  );
}
