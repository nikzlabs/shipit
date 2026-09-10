// eslint-disable-next-line no-restricted-imports -- timer cleanup on unmount
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircleIcon,
  CheckIcon,
  ChatCircleDotsIcon,
  ArrowRightIcon,
  ListChecksIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import type { ActionChecklistCard as ActionChecklistCardData } from "../../server/shared/types.js";
import { useSessionStore } from "../stores/session-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { Button } from "./ui/button.js";
import { formatProposalMessage, formatCommentSnapshot } from "../utils/action-checklist-message.js";

export interface ActionChecklistCardProps {
  card: ActionChecklistCardData;
  /** Returns whether the message was accepted for delivery. */
  onSubmit?: (text: string) => boolean;
}

const ACK_MS = 5000;

export function ActionChecklistCard({ card, onSubmit }: ActionChecklistCardProps) {
  const isSingle = card.actions.length === 1;

  const initialSelected = useMemo(
    () => new Set(card.actions.filter((a) => a.defaultChecked).map((a) => a.id)),
    [card.actions],
  );
  const [selected, setSelected] = useState<Set<string>>(initialSelected);

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
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [clearAck],
  );

  const selectedActions = useMemo(
    () => (isSingle ? card.actions : card.actions.filter((a) => selected.has(a.id))),
    [isSingle, card.actions, selected],
  );

  const handleSubmit = useCallback(() => {
    const chosen = isSingle ? card.actions : card.actions.filter((a) => selected.has(a.id));
    if (chosen.length === 0) return;
    const delivered = onSubmit?.(formatProposalMessage(card, chosen)) ?? false;
    if (ackTimer.current) clearTimeout(ackTimer.current);
    if (!delivered) {
      setAckCount(null);
      setSendFailed(true);
      ackTimer.current = setTimeout(() => setSendFailed(false), ACK_MS);
      return;
    }
    setSendFailed(false);
    setSelected(new Set());
    setAckCount(chosen.length);
    ackTimer.current = setTimeout(() => setAckCount(null), ACK_MS);
  }, [isSingle, card, selected, onSubmit]);

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
        <span className="font-medium text-(--color-text-primary)">
          {card.title ?? (isSingle ? "Suggested next step" : "Optional follow-ups")}
        </span>
        {!isSingle && (
          <span className="text-(--color-text-tertiary)">
            · {card.actions.length} actions
          </span>
        )}
      </div>

      {isSingle ? (
        <div className="pl-0.5">
          <div className="text-(--color-text-primary) font-medium">{card.actions[0].label}</div>
          {card.actions[0].description && (
            <div className="text-(--color-text-secondary) mt-0.5">
              {card.actions[0].description}
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-0.5" role="group" aria-label={card.title ?? "Optional follow-ups"}>
          {card.actions.map((a) => {
            const checked = selected.has(a.id);
            return (
              <label
                key={a.id}
                className={`flex items-start gap-2.5 rounded-md px-2 py-1.5 cursor-pointer transition-colors ${
                  checked ? "bg-(--color-accent-subtle)" : "hover:bg-(--color-bg-hover)"
                }`}
              >
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={checked}
                  onChange={() => toggle(a.id)}
                />
                <span
                  aria-hidden="true"
                  className={`shrink-0 mt-0.5 inline-flex items-center justify-center w-4 h-4 rounded border transition-colors ${
                    checked
                      ? "bg-(--color-accent) border-(--color-accent) text-(--color-accent-text)"
                      : "border-(--color-border-primary) text-transparent"
                  }`}
                >
                  <CheckIcon size={ICON_SIZE.XS} weight="bold" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="text-(--color-text-primary) font-medium">{a.label}</span>
                  {a.defaultChecked && (
                    <span className="ml-1.5 align-middle text-[10px] font-semibold tracking-wide text-(--color-text-link) bg-(--color-accent-subtle) rounded-full px-1.5 py-px">
                      RECOMMENDED
                    </span>
                  )}
                  {a.description && (
                    <span className="block text-(--color-text-secondary) mt-0.5">{a.description}</span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
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
        <Button variant="primary" size="md" onClick={handleSubmit} disabled={submitDisabled}>
          <ArrowRightIcon size={ICON_SIZE.SM} weight="bold" />
          {submitLabel}
        </Button>
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
