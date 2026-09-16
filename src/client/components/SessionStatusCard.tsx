// eslint-disable-next-line no-restricted-imports -- timer cleanup on unmount
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ChatCircleDotsIcon,
  ClipboardTextIcon,
  ClockCounterClockwiseIcon,
  GaugeIcon,
  ListChecksIcon,
  StepsIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
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

/** A rule opens each section inside a card, above its subtitle. */
const SECTION = "mt-2.5 pt-2.5 border-t border-(--color-accent)/25";

/**
 * A section heading *inside* a card: an accent icon beside a semibold primary
 * label, because a heading in text colour alone, however bold, blends into the
 * markdown above it. Only "Next steps" has these; the three cards' own names
 * are their caps.
 */
function Subtitle({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 mb-1">
      <span className="shrink-0 text-(--color-accent)">{icon}</span>
      <span className="text-[13px] font-semibold text-(--color-text-primary)">{children}</span>
    </div>
  );
}

/**
 * One of the three cards: a cap that names it over an accent-tinted body, so
 * the stack is the one coloured thing in a conversation and is found at a
 * glance rather than reading as one more transcript card (req 33).
 *
 * Three tones, because the three cards are not equally worth the user's eye
 * (req 33). "Next steps" asks something of them and takes the filled cap; the
 * status is read and takes a tinted cap with accent text; the last turn is the
 * quietest and leaves the accent altogether for the ordinary card surface —
 * the accent then means "the session, and what to do about it", and the turn
 * summary reads as the aside it is.
 *
 * `--color-info` was the better name for that third tone and cannot be used:
 * it is the same value as `--color-accent` in the light, cool-light and
 * antigravity themes, so it would differentiate nothing there.
 */
const TONES = {
  loud: {
    card: "border-(--color-accent)",
    cap: "bg-(--color-accent) text-(--color-accent-text)",
    body: "bg-(--color-accent-subtle)",
  },
  soft: {
    card: "border-(--color-accent)/45",
    cap: "bg-(--color-accent-subtle) text-(--color-accent) border-b border-(--color-accent)/30",
    body: "bg-(--color-accent)/5",
  },
  neutral: {
    card: "border-(--color-border-secondary)",
    cap: "bg-(--color-bg-tertiary) text-(--color-text-secondary) border-b border-(--color-border-secondary)",
    body: "bg-(--color-bg-secondary)",
  },
} as const;

function Capped({
  icon,
  title,
  tone,
  trailing,
  testId,
  children,
}: {
  icon: ReactNode;
  title: string;
  tone: keyof typeof TONES;
  trailing?: ReactNode;
  testId?: string;
  children: ReactNode;
}) {
  const skin = TONES[tone];
  return (
    <div
      {...(testId ? { "data-testid": testId } : {})}
      className={`overflow-hidden rounded-lg border ${skin.card}`}
    >
      <div className={`flex items-center gap-1.5 px-3 py-1 ${skin.cap}`}>
        <span className="shrink-0">{icon}</span>
        <span className="text-[13px] font-semibold">{title}</span>
        {trailing}
      </div>
      <div className={`px-3 py-2 ${skin.body}`}>{children}</div>
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
  /**
   * req 31 — the line is about the turn that wrote the card, so a stale card
   * hides it: the status ages into a rough description of the session, while a
   * turn line one turn behind is simply wrong.
   */
  const lastTurn = stale ? undefined : status.lastTurn;
  const hasOffers = status.actions.length > 0;
  const needsYou = status.needsYou ?? [];
  const hasNextSteps = hasOffers || needsYou.length > 0;

  return (
    <div data-testid="session-status-card" className="flex flex-col gap-2 text-xs">
      {/* req 33 — the session's own state comes first: it is what the user
          opens the session to read. req 27 — markdown, so a list reads as one. */}
      <Capped
        icon={<GaugeIcon size={ICON_SIZE.SM} />}
        title="Status"
        tone="soft"
        {...(stale
          ? {
              // req 14 — one mark for the whole stack, on the first cap, since
              // the stack has no single bottom-right corner any more. Full
              // strength, never faded: it is the smallest text on the cap.
              trailing: (
                <span className="ml-auto text-[11px] font-semibold text-(--color-accent)">
                  Stale
                </span>
              ),
            }
          : {})}
      >
        <div className={`text-(--color-text-primary) ${COMPACT_MARKDOWN}`}>
          <MarkdownContent text={status.status} />
        </div>
      </Capped>

      {/* req 33 — what the last turn did, between the session's state and what
          can happen next. The quietest of the three: it is an aside, and the
          user has usually just read the turn itself on screen above. */}
      {lastTurn && (
        <Capped
          icon={<ClockCounterClockwiseIcon size={ICON_SIZE.SM} />}
          title="Last turn"
          tone="neutral"
          testId="session-status-last-turn"
        >
          <div className={`text-(--color-text-primary) ${COMPACT_MARKDOWN}`}>
            <MarkdownContent text={lastTurn} />
          </div>
        </Capped>
      )}

      {/* req 33 — what can happen next goes last, in the loud tone: it is the
          only card that asks something of the user, it carries the one Submit
          (req 29), and last puts it nearest the composer. */}
      {hasNextSteps && (
        <Capped icon={<StepsIcon size={ICON_SIZE.SM} />} title="Next steps" tone="loud">
          {needsYou.length > 0 && (
            <div>
              <Subtitle icon={<ClipboardTextIcon size={ICON_SIZE.SM} />}>Manual steps</Subtitle>
              {/* req 29 — each step carries its own "I've done this" toggle. */}
              <ActionChecklist
                items={stepItems}
                selected={steps.selected}
                onToggle={steps.toggle}
                ariaLabel="Manual steps"
                toggleHint="I've done this"
              />
            </div>
          )}

          {/* req 26 — the offers are the transcript action card's, extended
              rather than reduced: same rows, badge, buttons and notice. */}
          {hasOffers && (
            <div className={needsYou.length > 0 ? SECTION : ""}>
              <Subtitle icon={<ListChecksIcon size={ICON_SIZE.SM} />}>Follow-ups</Subtitle>
              <ActionChecklist
                items={items}
                selected={selected}
                onToggle={toggle}
                ariaLabel="Follow-ups"
              />
            </div>
          )}

          <div className="mt-2 flex flex-col gap-2">
            {sendFailed && (
              <div className="flex items-center gap-1.5 text-(--color-warning)" role="status">
                <WarningCircleIcon size={ICON_SIZE.XS} weight="fill" />
                <span>Couldn&apos;t send — not connected. Your selection is kept; press Submit to retry.</span>
              </div>
            )}

            <div className="flex items-center gap-2">
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
        </Capped>
      )}
    </div>
  );
}
