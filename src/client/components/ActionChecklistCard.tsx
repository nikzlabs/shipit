/**
 * ActionChecklistCard — inline batch-resolve card for agent-proposed optional
 * actions (docs/207 / SHI-153).
 *
 * The agent proposes one or more INDEPENDENT optional follow-ups via the
 * `propose_actions` tool; the user resolves the subset they want with a SINGLE
 * batched submit — a button for one action, checkboxes + Submit for two or more.
 * The load-bearing contract: selection is local UI state until the user clicks,
 * and only then does ONE coherent message reach the agent (one message → one
 * turn), never N racing steering clicks (see CLAUDE.md WebSocket-lifecycle).
 *
 * The card is an immutable, reusable message composer with NO lifecycle: it never
 * locks, has no terminal/stale/dismissed state, and can be re-submitted with a
 * different subset indefinitely. The only post-submit visual change — clearing
 * the boxes and a brief "Submitted · N sent" ack — is transient CLIENT-ONLY state
 * (the spinner category, never persisted); on reload the card rehydrates from its
 * immutable definition. The durable record of a submit is the user message in the
 * transcript below, not anything on the card.
 *
 * Two resolve paths, identical across single- and multi-action cards:
 *   • Submit / Do it — concatenate the selected payloads into one user turn.
 *     Disabled when nothing is selected (nothing to send).
 *   • Add comment… — seed the MAIN composer with a `[x]`/`[ ]` snapshot of the
 *     whole menu (so voice + free text apply), never disabled. There is no
 *     card-local input on purpose: ShipIt's voice input lives in the composer.
 */

// eslint-disable-next-line no-restricted-imports -- useEffect is used solely to clear the transient-ack setTimeout on unmount (a browser-timer subscription cleanup), which is exactly the escape-hatch case.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircleIcon,
  CheckIcon,
  ChatCircleDotsIcon,
  ArrowRightIcon,
  ListChecksIcon,
} from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import type { ActionChecklistCard as ActionChecklistCardData } from "../../server/shared/types.js";
import { useSessionStore } from "../stores/session-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { Button } from "./ui/button.js";
import { formatProposalMessage, formatCommentSnapshot } from "../utils/action-checklist-message.js";

export interface ActionChecklistCardProps {
  card: ActionChecklistCardData;
  /**
   * Send one user message (queue-aware) — wired to the same follow-up sender the
   * rest of the chat uses, so Submit starts a turn when idle or queues mid-turn.
   */
  onSubmit?: (text: string) => void;
}

/** How long the transient "Submitted · N sent" ack lingers before fading. */
const ACK_MS = 5000;

export function ActionChecklistCard({ card, onSubmit }: ActionChecklistCardProps) {
  const isSingle = card.actions.length === 1;

  // Selection is ephemeral client state, recomputed from the immutable card each
  // mount (defaultChecked = the agent's recommendation; the user still decides).
  const initialSelected = useMemo(
    () => new Set(card.actions.filter((a) => a.defaultChecked).map((a) => a.id)),
    [card.actions],
  );
  const [selected, setSelected] = useState<Set<string>>(initialSelected);

  // Transient post-Submit acknowledgement — client-only, never persisted.
  const [ackCount, setAckCount] = useState<number | null>(null);
  const ackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // eslint-disable-next-line no-restricted-syntax -- clears the pending transient-ack timer on unmount so it can't fire setState after teardown; there is no event-handler/derived-state equivalent for unmount cleanup.
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

  // The selected actions in the card's deterministic order. For a single-action
  // card the lone action is the implicit selection (no checkbox to tick).
  const selectedActions = useMemo(
    () => (isSingle ? card.actions : card.actions.filter((a) => selected.has(a.id))),
    [isSingle, card.actions, selected],
  );

  const handleSubmit = useCallback(() => {
    // Snapshot the selection atomically here; never re-read checkbox state after.
    const chosen = isSingle ? card.actions : card.actions.filter((a) => selected.has(a.id));
    if (chosen.length === 0) return;
    onSubmit?.(formatProposalMessage(card, chosen));
    // Transient client-only ack: clear the boxes and confirm. Never persisted.
    setSelected(new Set());
    setAckCount(chosen.length);
    if (ackTimer.current) clearTimeout(ackTimer.current);
    ackTimer.current = setTimeout(() => setAckCount(null), ACK_MS);
  }, [isSingle, card, selected, onSubmit]);

  const handleAddComment = useCallback(() => {
    // For a single-action card the lone action is the implicit selection.
    const selectedIds = isSingle ? new Set(card.actions.map((a) => a.id)) : selected;
    const snapshot = formatCommentSnapshot(card, selectedIds);
    // Seed the main composer (where voice + free text live) and reveal it on
    // mobile. Add comment leaves the card untouched — no ack, no reset.
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
      {/* Head */}
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

      {/* Body: single action (no checkbox) or a checklist */}
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

      {/* Transient post-Submit ack — client-only, dies on reload. */}
      {ackCount !== null && (
        <div className="flex items-center gap-1.5 text-(--color-success)">
          <CheckCircleIcon size={ICON_SIZE.XS} weight="fill" />
          <span>
            Submitted · {ackCount} action{ackCount === 1 ? "" : "s"} sent
          </span>
        </div>
      )}

      {/* Footer buttons */}
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
