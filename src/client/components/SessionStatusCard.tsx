// eslint-disable-next-line no-restricted-imports -- timer cleanup on unmount
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChatCircleDotsIcon, ClipboardTextIcon, ListChecksIcon, WarningCircleIcon } from "@phosphor-icons/react";
import type { SessionStatus } from "../../server/shared/types.js";
import { ICON_SIZE } from "../design-tokens.js";
import { useSessionStore } from "../stores/session-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { Button } from "./ui/button.js";
import { MarkdownContent } from "./message-markdown.js";
import {
  ActionChecklist,
  ChecklistSubmitButton,
  useChecklistSelection,
  type ChecklistItem,
} from "./ActionChecklist.js";
import {
  formatOfferedActionsComment,
  formatOfferedActionsMessage,
} from "../utils/action-checklist-message.js";

const NOTICE_MS = 5000;

/**
 * `MarkdownContent` carries `prose-sm`, a size up from the card's `text-xs`.
 * The card is a summary beside its labels, not a message bubble, so the prose
 * is pulled back to the card's own size; the em-based prose margins follow it.
 */
const COMPACT_MARKDOWN = "[&_.prose]:text-xs [&_.prose]:leading-snug";

/** A rule opens each section, above its subtitle. */
const SECTION = "mt-2.5 pt-2.5 border-t border-(--color-border-secondary)";

/**
 * The card's section headings. They are the transcript action card's header
 * row — an accent icon beside a medium primary label — because a heading in
 * text colour alone, however bold, blends into the markdown above it.
 */
function Subtitle({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 mb-1">
      <span className="shrink-0 text-(--color-accent)">{icon}</span>
      <span className="text-[13px] font-semibold text-(--color-text-primary)">{children}</span>
    </div>
  );
}

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
   * req 17 — an offer reads as sent the moment its message goes, without waiting
   * for the server's `takenAt`, which is a round trip behind. It stays tickable:
   * the grey and the "SENT" tag are presentation, not a lock.
   */
  const [sent, setSent] = useState<ReadonlySet<string>>(() => new Set());
  /** req 29 — manual steps the user has ticked and already told the agent about. */
  const [reportedSteps, setReportedSteps] = useState<ReadonlySet<string>>(() => new Set());
  const [sendFailed, setSendFailed] = useState(false);
  const failedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // eslint-disable-next-line no-restricted-syntax -- timer cleanup on unmount
  useEffect(
    () => () => {
      if (failedTimer.current) clearTimeout(failedTimer.current);
    },
    [],
  );

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

  const stepItems = useMemo<ChecklistItem[]>(
    () =>
      (status.needsYou ?? []).map((entry) => ({
        key: entry,
        label: entry,
        ...(reportedSteps.has(entry) ? { taken: true } : {}),
      })),
    [status.needsYou, reportedSteps],
  );
  const steps = useChecklistSelection(stepItems);

  const handleSubmit = useCallback(() => {
    // req 17 — a sent offer stays selectable, so a ticked one is re-sent on
    // purpose: an agent that crashed or ignored it needs telling again.
    const chosen = status.actions.filter((offer) => selected.has(offer.offerId));
    const done = (status.needsYou ?? []).filter((entry) => steps.selected.has(entry));
    if (chosen.length === 0 && done.length === 0) return;
    const offerIds = chosen.map((offer) => offer.offerId);
    const delivered = onSubmit?.(formatOfferedActionsMessage(chosen, done), {
      ...(offerIds.length > 0 ? { sessionStatusOfferIds: offerIds } : {}),
    }) ?? false;
    if (failedTimer.current) clearTimeout(failedTimer.current);
    // A refused message keeps the selection, so pressing submit again retries it.
    if (!delivered) {
      setSendFailed(true);
      failedTimer.current = setTimeout(() => setSendFailed(false), NOTICE_MS);
      return;
    }
    setSendFailed(false);
    setSent((prev) => new Set([...prev, ...offerIds]));
    setReportedSteps((prev) => new Set([...prev, ...done]));
    clear();
    steps.clear();
  }, [status.actions, status.needsYou, selected, steps, onSubmit, clear]);

  const handleAddComment = useCallback(() => {
    const chosen = status.actions.filter((offer) => selected.has(offer.offerId));
    const done = (status.needsYou ?? []).filter((entry) => steps.selected.has(entry));
    useSessionStore.getState().setPrefillText(formatOfferedActionsComment(chosen, done));
    useUiStore.getState().setMobilePanel("chat");
  }, [status.actions, status.needsYou, selected, steps.selected]);

  const nothingTicked = selected.size === 0 && steps.selected.size === 0;

  const stale = !status.fresh;
  // The "Stale" label is drawn over the card's bottom-right corner.
  const clearOfStale = stale ? "pr-11" : "";
  const hasOffers = status.actions.length > 0;
  const needsYou = status.needsYou ?? [];

  return (
    <div
      data-testid="session-status-card"
      className="relative rounded-lg border border-(--color-border-secondary)/60 bg-(--color-bg-secondary)/50 px-3 py-2 text-xs"
    >
      {/* req 27 — the status is markdown, so a list in it reads as a list. */}
      <div className={`text-(--color-text-primary) ${COMPACT_MARKDOWN} ${hasOffers || needsYou.length > 0 ? "" : clearOfStale}`}>
        <MarkdownContent text={status.status} />
      </div>

      {needsYou.length > 0 && (
        <div className={SECTION}>
          <Subtitle icon={<ClipboardTextIcon size={ICON_SIZE.SM} />}>Manual steps</Subtitle>
          {/* req 29 — each step carries its own "I've done this" toggle. */}
          <div>
            <ActionChecklist
              items={stepItems}
              selected={steps.selected}
              onToggle={steps.toggle}
              ariaLabel="Manual steps"
              toggleHint="I've done this"
            />
          </div>
        </div>
      )}

      {/* req 26 — the offers are the transcript action card's, extended rather
          than reduced: same rows, badge, buttons and delivery notice. */}
      {hasOffers && (
        <div className={SECTION}>
          <Subtitle icon={<ListChecksIcon size={ICON_SIZE.SM} />}>Follow-ups</Subtitle>
          <ActionChecklist
            items={items}
            selected={selected}
            onToggle={toggle}
            ariaLabel="Follow-ups"
          />
        </div>
      )}

      {/* One submit for the whole card: the approved offers and the steps the
          user reports doing travel in one message (req 29). */}
      {(hasOffers || needsYou.length > 0) && (
        <div className="mt-2 flex flex-col gap-2">
          {sendFailed && (
            <div className="flex items-center gap-1.5 text-(--color-warning)" role="status">
              <WarningCircleIcon size={ICON_SIZE.XS} weight="fill" />
              <span>Couldn&apos;t send — not connected. Your selection is kept; press Submit to retry.</span>
            </div>
          )}

          <div className={`flex items-center gap-2 ${clearOfStale}`}>
            <ChecklistSubmitButton
              label="Submit"
              disabled={nothingTicked}
              onClick={handleSubmit}
            />
            <Button variant="ghost" size="md" onClick={handleAddComment}>
              <ChatCircleDotsIcon size={ICON_SIZE.SM} />
              Add comment…
            </Button>
          </div>
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
