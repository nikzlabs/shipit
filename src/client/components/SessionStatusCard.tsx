import { useCallback, useMemo, useState } from "react";
import type { SessionStatus } from "../../server/shared/types.js";
import {
  ActionChecklist,
  ChecklistSubmitButton,
  useChecklistSelection,
  type ChecklistItem,
} from "./ActionChecklist.js";
import { formatOfferedActionsMessage } from "../utils/action-checklist-message.js";

export interface SessionStatusCardProps {
  status: SessionStatus;
  /** Returns whether the message was accepted for delivery. */
  onSubmit?: (
    text: string,
    options?: { sessionStatusOfferIds?: string[] },
  ) => boolean;
}

/**
 * docs/303-session-status-card — the agent's card at the end of the
 * conversation. Not a transcript row: it is read from the session record.
 */
export function SessionStatusCard({ status, onSubmit }: SessionStatusCardProps) {
  /**
   * req 17 — an offer stops being selectable the moment its message is sent.
   * The server's `takenAt` is a round trip behind, and a second submit in that
   * window would send the same work twice.
   */
  const [sent, setSent] = useState<ReadonlySet<string>>(() => new Set());

  const items = useMemo<ChecklistItem[]>(
    () =>
      status.actions.map((offer) => ({
        key: offer.offerId,
        label: offer.label,
        ...(offer.description ? { description: offer.description } : {}),
        ...(offer.defaultChecked ? { defaultChecked: true } : {}),
        ...(offer.takenAt || sent.has(offer.offerId) ? { taken: true } : {}),
      })),
    [status.actions, sent],
  );
  const { selected, toggle, clear } = useChecklistSelection(items);

  const handleSubmit = useCallback(() => {
    const chosen = status.actions.filter(
      (offer) => !offer.takenAt && selected.has(offer.offerId),
    );
    if (chosen.length === 0) return;
    const offerIds = chosen.map((offer) => offer.offerId);
    const delivered = onSubmit?.(formatOfferedActionsMessage(chosen), {
      sessionStatusOfferIds: offerIds,
    }) ?? false;
    // A refused message keeps the selection, so pressing Send again retries it.
    if (!delivered) return;
    setSent((prev) => new Set([...prev, ...offerIds]));
    clear();
  }, [status.actions, selected, onSubmit, clear]);

  const stale = !status.fresh;
  // The "Stale" label is drawn over the card's bottom-right corner.
  const clearOfStale = stale ? "pr-11" : "";
  const hasOffers = status.actions.length > 0;

  return (
    <div
      data-testid="session-status-card"
      className="relative rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) px-3 py-2 text-xs"
    >
      <div className="grid grid-cols-[76px_1fr] gap-x-2.5 gap-y-1">
        <span className="text-(--color-text-tertiary)">Status</span>
        <span className={`text-(--color-text-primary) ${hasOffers || status.needsYou ? "" : clearOfStale}`}>
          {status.status}
        </span>
        {status.needsYou && (
          <>
            <span className="text-(--color-text-tertiary)">Needs you</span>
            <span className={`text-(--color-text-primary) ${hasOffers ? "" : clearOfStale}`}>
              {status.needsYou}
            </span>
          </>
        )}
      </div>

      {hasOffers && (
        <div className={`mt-2 pt-2 border-t border-(--color-border-secondary) ${clearOfStale}`}>
          <ActionChecklist
            items={items}
            selected={selected}
            onToggle={toggle}
            ariaLabel="Offered actions"
            dense
            trailing={
              <ChecklistSubmitButton
                label="Send"
                disabled={selected.size === 0}
                onClick={handleSubmit}
                dense
              />
            }
          />
        </div>
      )}

      {stale && (
        <span className="absolute right-2.5 bottom-1.5 text-[11px] font-semibold text-(--color-accent)">
          Stale
        </span>
      )}
    </div>
  );
}
