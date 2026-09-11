import { CaretRightIcon, EyeIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import type { IssueRefCard as IssueRefCardData } from "../../server/shared/types.js";
import { useIssuesStore } from "../stores/issues-store.js";

export interface IssueRefCardProps {
  card: IssueRefCardData;
  onOpen?: (ref: { tracker: IssueRefCardData["tracker"]; identifier: string; title?: string; url?: string }) => void;
}

function isDone(statusType?: string): boolean {
  return statusType === "completed" || statusType === "canceled";
}

export function IssueRefCard({ card, onOpen }: IssueRefCardProps) {
  const done = isDone(card.statusType);

  const open = () => {
    // Resolve the recorded name at use time so tracker re-points take effect.
    const repointed = card.trackerName
      ? useIssuesStore.getState().trackers.find((t) => t.name === card.trackerName)
      : undefined;
    onOpen?.({
      tracker: repointed?.id ?? card.tracker,
      identifier: card.identifier,
      ...(card.title ? { title: card.title } : {}),
      ...(card.url ? { url: card.url } : {}),
    });
  };

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
