// eslint-disable-next-line no-restricted-imports -- timer cleanup on unmount
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircleIcon,
  ChatCircleDotsIcon,
  ListChecksIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import type { ActionChecklistCard as ActionChecklistCardData } from "../../server/shared/types.js";
import { useSessionStore } from "../stores/session-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { Button } from "./ui/button.js";
import {
  ActionChecklist,
  ChecklistSubmitButton,
  useChecklistSelection,
  type ChecklistItem,
} from "./ActionChecklist.js";
import { InlineMarkdown } from "./message-markdown.js";
import { formatProposalMessage, formatCommentSnapshot } from "../utils/action-checklist-message.js";

export interface ActionChecklistCardProps {
  card: ActionChecklistCardData;
  /** Returns whether the message was accepted for delivery. */
  onSubmit?: (text: string, options?: { actionChecklistCardId?: string }) => boolean;
}

const ACK_MS = 5000;

export function ActionChecklistCard({ card, onSubmit }: ActionChecklistCardProps) {
  const isSingle = card.actions.length === 1;

  const items = useMemo<ChecklistItem[]>(
    () =>
      card.actions.map((a) => ({
        key: a.id,
        label: a.label,
        description: a.description,
        defaultChecked: a.defaultChecked,
      })),
    [card.actions],
  );
  const { selected, toggle: toggleSelection, clear: clearSelection } = useChecklistSelection(items);

  const [ackCount, setAckCount] = useState<number | null>(null);
  const [sendFailed, setSendFailed] = useState(false);
  const ackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // eslint-disable-next-line no-restricted-syntax -- timer cleanup on unmount
  useEffect(
    () => () => {
      if (ackTimer.current) clearTimeout(ackTimer.current);
    },
    [],
  );

  const clearAck = useCallback(() => {
    if (ackTimer.current) clearTimeout(ackTimer.current);
    ackTimer.current = null;
    setAckCount(null);
    setSendFailed(false);
  }, []);

  const toggle = useCallback(
    (id: string) => {
      clearAck();
      toggleSelection(id);
    },
    [clearAck, toggleSelection],
  );

  const selectedActions = useMemo(
    () => (isSingle ? card.actions : card.actions.filter((a) => selected.has(a.id))),
    [isSingle, card.actions, selected],
  );

  const handleSubmit = useCallback(() => {
    const chosen = isSingle ? card.actions : card.actions.filter((a) => selected.has(a.id));
    if (chosen.length === 0) return;
    const delivered =
      onSubmit?.(formatProposalMessage(card, chosen), { actionChecklistCardId: card.cardId })
      ?? false;
    if (ackTimer.current) clearTimeout(ackTimer.current);
    if (!delivered) {
      setAckCount(null);
      setSendFailed(true);
      ackTimer.current = setTimeout(() => setSendFailed(false), ACK_MS);
      return;
    }
    setSendFailed(false);
    clearSelection();
    setAckCount(chosen.length);
    ackTimer.current = setTimeout(() => setAckCount(null), ACK_MS);
  }, [isSingle, card, selected, onSubmit, clearSelection]);

  const handleAddComment = useCallback(() => {
    const selectedIds = isSingle ? new Set(card.actions.map((a) => a.id)) : selected;
    const snapshot = formatCommentSnapshot(card, selectedIds);
    useSessionStore.getState().setPrefillText(snapshot);
    useUiStore.getState().setMobilePanel("chat");
  }, [isSingle, card, selected]);

  const submitDisabled = selectedActions.length === 0;
  const submitLabel = isSingle
    ? "Do it"
    : selectedActions.length > 0
      ? `Submit ${selectedActions.length} action${selectedActions.length === 1 ? "" : "s"}`
      : "Submit";

  return (
    <div
      data-testid="action-checklist-card"
      className="rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) p-3 text-xs flex flex-col gap-2.5"
    >
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-(--color-accent)">
          {isSingle ? (
            <CheckCircleIcon size={ICON_SIZE.SM} />
          ) : (
            <ListChecksIcon size={ICON_SIZE.SM} />
          )}
        </span>
        {card.title ? (
          <InlineMarkdown text={card.title} shipitLinks className="font-medium text-(--color-text-primary)" />
        ) : (
          <span className="font-medium text-(--color-text-primary)">
            {isSingle ? "Suggested next step" : "Optional follow-ups"}
          </span>
        )}
        {!isSingle && (
          <span className="text-(--color-text-tertiary)">
            · {card.actions.length} actions
          </span>
        )}
      </div>

      {isSingle ? (
        // req 41 — the same markdown the checklist rows render, so a single
        // action is not the one place a link the agent wrote comes out as text.
        <div className="pl-0.5">
          <InlineMarkdown
            text={card.actions[0].label}
            shipitLinks
            className="block text-(--color-text-primary) font-medium"
          />
          {card.actions[0].description && (
            <InlineMarkdown
              text={card.actions[0].description}
              shipitLinks
              className="block text-(--color-text-secondary) mt-0.5"
            />
          )}
        </div>
      ) : (
        <ActionChecklist
          items={items}
          selected={selected}
          onToggle={toggle}
          ariaLabel={card.title ?? "Optional follow-ups"}
        />
      )}

      {sendFailed && (
        <div className="flex items-center gap-1.5 text-(--color-warning)" role="status">
          <WarningCircleIcon size={ICON_SIZE.XS} weight="fill" />
          <span>Couldn&apos;t send — not connected. Your selection is kept; press Submit to retry.</span>
        </div>
      )}

      {ackCount !== null && (
        <div className="flex items-center gap-1.5 text-(--color-success)">
          <CheckCircleIcon size={ICON_SIZE.XS} weight="fill" />
          <span>
            Submitted · {ackCount} action{ackCount === 1 ? "" : "s"} sent
          </span>
        </div>
      )}

      <div className="flex items-center gap-2">
        <ChecklistSubmitButton label={submitLabel} disabled={submitDisabled} onClick={handleSubmit} />
        <Button variant="ghost" size="md" onClick={handleAddComment}>
          <ChatCircleDotsIcon size={ICON_SIZE.SM} />
          Add comment…
        </Button>
      </div>

      {card.headSha && (
        <div className="text-(--color-text-tertiary) text-[11px]">
          Proposed {card.createdAt.slice(0, 10)}
          {card.branch ? ` against ${card.branch}` : ""} · ticking declares intent; the agent does the work.
        </div>
      )}
    </div>
  );
}
