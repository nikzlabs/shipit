/**
 * ScheduleProposalCard — a schedule, or a change to one, that the agent proposes; Confirm is what
 * saves it (docs/324-scheduled-sessions reqs 8, 9).
 *
 * The values are ShipIt's words, rendered when the card was written; the prompt is shown as plain
 * text, never markdown, so nothing in it can look like ShipIt's own chrome. The next run times are
 * worked out here because they are in the browser's time zone, and a proposal that names no zone
 * gets the browser's on Confirm. Once decided, the card collapses to one line in the scrollback.
 */

import { useState } from "react";
import {
  CalendarPlusIcon,
  CheckCircleIcon,
  WarningIcon,
  XCircleIcon,
  type Icon,
} from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import { nextRuns } from "../../server/shared/schedule-timing.js";
import type {
  ScheduleProposalCard as ScheduleProposalCardData,
  ScheduleProposalPhase,
  ScheduleProposalValue,
} from "../../server/shared/types.js";

export type ScheduleProposalAction = "confirm" | "cancel";

export interface ScheduleProposalCardProps {
  card: ScheduleProposalCardData;
  /** `timeZone` is the browser's, sent only when the proposal names no zone. */
  onDecide?: (cardId: string, action: ScheduleProposalAction, timeZone?: string) => Promise<void> | void;
  /** Tests pin these; the browser's own otherwise. */
  browserTimeZone?: string;
  now?: Date;
}

const NEXT_RUNS_SHOWN = 3;

interface ResolvedLook {
  icon: Icon;
  tone: string;
  headline: string;
}

const RESOLVED: Record<Exclude<ScheduleProposalPhase, "pending">, ResolvedLook> = {
  confirmed: { icon: CheckCircleIcon, tone: "text-(--color-success)", headline: "Saved" },
  cancelled: { icon: XCircleIcon, tone: "text-(--color-text-tertiary)", headline: "Cancelled" },
  stale: { icon: WarningIcon, tone: "text-(--color-warning)", headline: "Not saved" },
  refused: { icon: WarningIcon, tone: "text-(--color-warning)", headline: "Not saved" },
};

function resolvedClause(card: ScheduleProposalCardData): string {
  switch (card.phase) {
    case "confirmed":
      return card.kind === "create" ? `schedule ${card.name} created` : `schedule ${card.name} changed`;
    case "cancelled":
      return card.kind === "create" ? `schedule ${card.name} was not created` : `schedule ${card.name} is unchanged`;
    case "stale":
      return "the schedule changed after this card was written";
    default:
      return card.outcome ?? "ShipIt could no longer accept this proposal";
  }
}

function formatRun(date: Date, timeZone: string): string {
  return date.toLocaleString(undefined, {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function upcomingRuns(card: ScheduleProposalCardData, browserZone: string, now: Date): string[] | null {
  try {
    return nextRuns(card.timing, card.timeZone ?? browserZone, NEXT_RUNS_SHOWN, now).map((d) => formatRun(d, browserZone));
  } catch {
    return null;
  }
}

function ValueRow({ value }: { value: ScheduleProposalValue }) {
  return (
    <>
      <dt className="text-(--color-text-tertiary)">{value.label}</dt>
      <dd className="min-w-0 break-words text-(--color-text-primary)" data-testid={`schedule-proposal-value-${value.label}`}>
        {value.before !== undefined && (
          <>
            <span className="text-(--color-text-secondary) line-through decoration-(--color-text-tertiary)">
              {value.before}
            </span>
            <span className="mx-1.5 text-(--color-text-tertiary)" aria-label="becomes">→</span>
          </>
        )}
        <span className={value.before !== undefined ? "font-medium" : undefined}>{value.after}</span>
      </dd>
    </>
  );
}

function PromptText({ label, text, struck }: { label: string; text: string; struck?: boolean }) {
  return (
    <div className="mt-2">
      <div className="text-[11px] text-(--color-text-tertiary)">{label}</div>
      <pre
        className={`mt-0.5 max-h-48 overflow-auto rounded border border-(--color-border-secondary) bg-(--color-bg-tertiary) px-2 py-1.5 font-sans text-xs whitespace-pre-wrap break-words ${
          struck ? "text-(--color-text-secondary) line-through decoration-(--color-text-tertiary)" : "text-(--color-text-primary)"}`}
      >
        {text}
      </pre>
    </div>
  );
}

export function ScheduleProposalCard({ card, onDecide, browserTimeZone, now }: ScheduleProposalCardProps) {
  const [busy, setBusy] = useState<ScheduleProposalAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (card.phase !== "pending") {
    const { icon: Icon, tone, headline } = RESOLVED[card.phase];
    return (
      <div
        data-testid="schedule-proposal-card"
        data-phase={card.phase}
        className="flex items-start gap-2 rounded-lg border border-(--color-border-primary) bg-(--color-bg-tertiary) px-3 py-2 text-sm text-(--color-text-secondary)"
      >
        <Icon size={ICON_SIZE.SM} weight="fill" className={`mt-0.5 shrink-0 ${tone}`} aria-hidden />
        <span className="min-w-0">
          <strong className={tone}>{headline}</strong>{" "}
          <span className="text-(--color-text-tertiary)" aria-hidden>·</span>{" "}
          {resolvedClause(card)}
        </span>
      </div>
    );
  }

  const zone = browserTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const runs = card.enabled ? upcomingRuns(card, zone, now ?? new Date()) : [];

  const decide = async (action: ScheduleProposalAction) => {
    if (!onDecide || busy) return;
    setBusy(action);
    setError(null);
    try {
      await onDecide(card.cardId, action, action === "confirm" && card.timeZone === null ? zone : undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      data-testid="schedule-proposal-card"
      data-phase="pending"
      className="rounded-lg border border-(--color-accent)/40 bg-(--color-accent-subtle) px-4 py-3"
    >
      <div className="flex items-start gap-2.5">
        <CalendarPlusIcon size={ICON_SIZE.MD} className="mt-0.5 shrink-0 text-(--color-accent)" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-(--color-text-primary)">
            {card.kind === "create" ? "Schedule proposed" : "Schedule change proposed"}
          </div>
          <div className="mt-0.5 text-xs text-(--color-text-tertiary)">{card.name}</div>

          <div className="mt-2.5 rounded-md border border-(--color-border-secondary) bg-(--color-bg-primary) px-3 py-2">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              {card.values.map((value) => <ValueRow key={value.label} value={value} />)}
              {card.timeZone === null && <ValueRow value={{ label: "Time zone", after: `${zone} (yours)` }} />}
              <dt className="text-(--color-text-tertiary)">Next runs</dt>
              <dd className="text-(--color-text-primary)" data-testid="schedule-proposal-next-runs">
                {!card.enabled
                  ? "None while paused"
                  : runs === null
                    ? "Cannot be worked out"
                    : runs.join(" · ")}
              </dd>
            </dl>
            {card.prompt?.before !== undefined && <PromptText label="Prompt before" text={card.prompt.before} struck />}
            {card.prompt && (
              <PromptText label={card.prompt.before !== undefined ? "Prompt after" : "Prompt"} text={card.prompt.after} />
            )}
          </div>

          <div className="mt-2.5 text-xs text-(--color-text-secondary)">
            Nothing is saved until you confirm. Each run starts a session with these values and this prompt.
          </div>
          {error && (
            <div role="alert" className="mt-2 text-xs text-(--color-error)">
              {error}
            </div>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            <Button disabled={busy !== null} onClick={() => { void decide("confirm"); }}>
              {busy === "confirm" ? "Confirming…" : "Confirm"}
            </Button>
            <Button variant="ghost" disabled={busy !== null} onClick={() => { void decide("cancel"); }}>
              Cancel
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
