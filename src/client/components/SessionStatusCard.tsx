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
  type ReportedStep,
} from "../utils/action-checklist-message.js";

const NOTICE_MS = 5000;

/**
 * A manual step has no server-side identity (`needsYou: string[]`) and needs
 * none: a note is never stored, so its text is the key, which is what carries a
 * note and a SENT grey across the agent rewriting the list around it. A repeated
 * entry gets a suffix so two identical steps are two rows (docs/303 req 37).
 */
function stepKeys(entries: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return entries.map((entry) => {
    const n = seen.get(entry) ?? 0;
    seen.set(entry, n + 1);
    return n === 0 ? entry : `${entry}\u0000${n}`;
  });
}

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
 * status is read and takes a tinted cap; the last turn is the quietest and
 * leaves the accent altogether for the ordinary card surface — the accent then
 * means "the session, and what to do about it", and the turn summary reads as
 * the aside it is.
 *
 * `--color-info` was the better name for that third tone and cannot be used:
 * it is the same value as `--color-accent` in the light, cool-light and
 * antigravity themes, so it would differentiate nothing there.
 *
 * A cap's SURFACE carries its tone; its label does not. Only the filled cap has
 * a background solid enough to colour text against, so the other two label in
 * `--color-text-primary` and leave the tone to the icon: accent text on the
 * accent tint measures 2.57:1 in claude-light, and under 4.5:1 in six themes.
 */
const TONES = {
  loud: {
    card: "border-(--color-accent)",
    cap: "bg-(--color-accent) text-(--color-accent-text)",
    icon: "",
    body: "bg-(--color-accent-subtle)",
  },
  soft: {
    card: "border-(--color-accent)/45",
    cap: "bg-(--color-accent-subtle) text-(--color-text-primary) border-b border-(--color-accent)/30",
    icon: "text-(--color-accent)",
    body: "bg-(--color-accent)/5",
  },
  neutral: {
    card: "border-(--color-border-secondary)",
    cap: "bg-(--color-bg-tertiary) text-(--color-text-primary) border-b border-(--color-border-secondary)",
    icon: "text-(--color-text-secondary)",
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
        <span className={`shrink-0 ${skin.icon}`}>{icon}</span>
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
  /** req 37 — what the user typed against a step, keyed by the step's row key. */
  const [notes, setNotes] = useState<ReadonlyMap<string, string>>(() => new Map());
  /**
   * req 37 — rows whose note field is open. A field with text in it stays open
   * because the text is its content; an empty one closes when it loses focus, so
   * the control never leaves a row taller than the user asked for.
   */
  const [openNotes, setOpenNotes] = useState<ReadonlySet<string>>(() => new Set());
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

  /** The rows of the manual-step list, each with the key its local state uses. */
  const stepRows = useMemo(() => {
    const entries = status.needsYou ?? [];
    return stepKeys(entries).map((key, i) => ({ key, text: entries[i] }));
  }, [status.needsYou]);

  const stepBase = useMemo<ChecklistItem[]>(
    () =>
      stepRows.map((row) => ({
        key: row.key,
        label: row.text,
        ...(reportedSteps.has(row.key) ? { taken: true } : {}),
      })),
    [stepRows, reportedSteps],
  );
  // The selection is derived from the rows, so the ANSWERED mark — which
  // depends on it — is added afterwards rather than inside them.
  const steps = useChecklistSelection(stepBase);

  const stepItems = useMemo<ChecklistItem[]>(
    () =>
      stepBase.map((item) =>
        // req 37 — an unticked row normally sends nothing, and a note breaks
        // that, so the row says what it is about to do. A TICKED row with a
        // note is not answered: it is done, with a detail, and its tick already
        // says so.
        // Trimmed, because a note of spaces is not submitted either: the mark
        // and the submission must agree on what counts as an answer.
        notes.get(item.key)?.trim() && !steps.selected.has(item.key)
          ? { ...item, tag: "ANSWERED" }
          : item,
      ),
    [stepBase, notes, steps.selected],
  );

  /**
   * req 37 — a step is submitted when it is ticked, when it carries a note, or
   * both: done · answered · done with a detail. `tag` is only shown on the
   * unticked ones, where the mark is needed.
   */
  const submittedSteps = useMemo<ReportedStep[]>(
    () =>
      stepRows
        .map((row) => {
          const note = notes.get(row.key)?.trim() ?? "";
          return {
            text: row.text,
            done: steps.selected.has(row.key),
            ...(note ? { note } : {}),
          };
        })
        .filter((step) => step.done || step.note),
    [stepRows, steps.selected, notes],
  );

  const setNote = useCallback((key: string, value: string) => {
    setNotes((prev) => {
      const next = new Map(prev);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    });
  }, []);

  /**
   * The control is a toggle, and the field is NEVER closed by anything else —
   * in particular not by the blur of the user's next click. Closing on blur
   * removes the field on mousedown, which shifts everything under it up before
   * mouseup lands, so the click that caused it is swallowed: pressing Submit
   * with an empty note open submitted nothing.
   */
  const toggleNote = useCallback((key: string) => {
    setOpenNotes((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    // Closing discards the note, which is what the control says it does; an
    // open field kept out of sight would submit words the user cannot see.
    setNotes((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }, []);

  const handleSubmit = useCallback(() => {
    // req 17 — a sent offer stays selectable, so a ticked one is re-sent on
    // purpose: an agent that crashed or ignored it needs telling again.
    const chosen = status.actions.filter((offer) => selected.has(offer.offerId));
    if (chosen.length === 0 && submittedSteps.length === 0) return;
    const offerIds = chosen.map((offer) => offer.offerId);
    const delivered = onSubmit?.(formatOfferedActionsMessage(chosen, submittedSteps), {
      ...(offerIds.length > 0 ? { sessionStatusOfferIds: offerIds } : {}),
    }) ?? false;
    if (failedTimer.current) clearTimeout(failedTimer.current);
    // A refused message keeps the selection AND the notes, so pressing submit
    // again retries the whole of what the user composed.
    if (!delivered) {
      setSendFailed(true);
      failedTimer.current = setTimeout(() => setSendFailed(false), NOTICE_MS);
      return;
    }
    setSendFailed(false);
    setSent((prev) => new Set([...prev, ...offerIds]));
    // req 29 — a step that was answered has been reported too, so it greys like
    // one reported done; its note is delivered and lives in the transcript now.
    const reported = stepRows
      .filter((row) => steps.selected.has(row.key) || notes.get(row.key)?.trim())
      .map((row) => row.key);
    setReportedSteps((prev) => new Set([...prev, ...reported]));
    setNotes(new Map());
    setOpenNotes(new Set());
    clear();
    steps.clear();
  }, [status.actions, stepRows, notes, selected, steps, submittedSteps, onSubmit, clear]);

  const handleAddComment = useCallback(() => {
    const chosen = status.actions.filter((offer) => selected.has(offer.offerId));
    useSessionStore
      .getState()
      .setPrefillText(formatOfferedActionsComment(chosen, submittedSteps));
    useUiStore.getState().setMobilePanel("chat");
  }, [status.actions, selected, submittedSteps]);

  const nothingTicked = selected.size === 0 && submittedSteps.length === 0;

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
          <MarkdownContent text={status.status} shipitLinks />
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
            <MarkdownContent text={lastTurn} shipitLinks />
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
              {/* req 29 — each step carries its own "I've done this" toggle.
                  req 37 — and a note of its own, so a value ("I named it
                  billing-prod") or an answer ("no, use SQLite") reaches the
                  agent attached to the step it is about. */}
              <ActionChecklist
                items={stepItems}
                selected={steps.selected}
                onToggle={steps.toggle}
                ariaLabel="Manual steps"
                toggleHint="I've done this"
                renderTrailing={(item) => {
                  const open = openNotes.has(item.key);
                  return (
                    <button
                      type="button"
                      onClick={() => toggleNote(item.key)}
                      aria-label={`${open ? "Remove note" : "Add a note"}: ${item.label}`}
                      aria-expanded={open}
                      title={open ? "Remove note" : "Add a note"}
                      className={`shrink-0 mt-1 mr-1 rounded-md p-1 hover:bg-(--color-bg-hover) ${
                        open ? "text-(--color-accent)" : "text-(--color-text-tertiary)"
                      }`}
                    >
                      <ChatCircleDotsIcon size={ICON_SIZE.SM} />
                    </button>
                  );
                }}
                renderBelow={(item) =>
                  openNotes.has(item.key) ? (
                    <textarea
                      // Focused on mount: the field exists only because the
                      // user pressed the control that opens it.
                      autoFocus
                      rows={2}
                      value={notes.get(item.key) ?? ""}
                      onChange={(e) => setNote(item.key, e.target.value)}
                      aria-label={`Note: ${item.label}`}
                      placeholder="Add a note for the agent…"
                      className="w-full rounded-md border border-(--color-border-secondary) bg-(--color-bg-primary) px-2 py-1 text-xs text-(--color-text-primary) placeholder:text-(--color-text-tertiary) focus:border-(--color-accent) focus:outline-none"
                    />
                  ) : null
                }
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
