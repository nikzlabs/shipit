import { useState } from "react";
import { CheckCircleIcon, NotebookIcon, ProhibitIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import type { ScheduleNotesAccessCard as ScheduleNotesAccessCardData } from "../../server/shared/types.js";

export type ScheduleNotesAccessAction = "allow" | "deny";

export interface ScheduleNotesAccessCardProps {
  card: ScheduleNotesAccessCardData;
  onDecide?: (cardId: string, action: ScheduleNotesAccessAction) => Promise<void> | void;
}

/** docs/324-scheduled-sessions reqs 28, 30 — an agent asks to read one schedule's notes. */
export function ScheduleNotesAccessCard({ card, onDecide }: ScheduleNotesAccessCardProps) {
  const [busy, setBusy] = useState<ScheduleNotesAccessAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (card.phase !== "pending") {
    const allowed = card.phase === "allowed";
    const Icon = allowed ? CheckCircleIcon : ProhibitIcon;
    const tone = allowed ? "text-(--color-success)" : "text-(--color-text-tertiary)";
    return (
      <div
        data-testid="schedule-notes-access-card"
        data-phase={card.phase}
        className="rounded-lg border border-(--color-border-primary) bg-(--color-bg-tertiary) px-3 py-2 text-sm text-(--color-text-secondary)"
      >
        <span className={`inline-flex items-center gap-1.5 ${tone}`}>
          <Icon size={ICON_SIZE.SM} weight="fill" aria-hidden />
          <span>{allowed ? "Allowed for this session" : "Denied"}</span>{" "}
          <span className="text-(--color-text-tertiary)">· {card.scheduleName}</span>
        </span>
      </div>
    );
  }

  const decide = async (action: ScheduleNotesAccessAction) => {
    if (!onDecide || busy) return;
    setBusy(action);
    setError(null);
    try {
      await onDecide(card.cardId, action);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      data-testid="schedule-notes-access-card"
      data-phase="pending"
      className="rounded-lg border border-(--color-warning)/40 bg-(--color-warning-subtle) px-4 py-3"
    >
      <div className="flex items-start gap-2.5">
        <NotebookIcon
          size={ICON_SIZE.MD}
          weight="fill"
          className="mt-0.5 shrink-0 text-(--color-warning)"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-(--color-text-primary)">Read schedule notes?</div>
          <div className="mt-0.5 text-sm text-(--color-text-secondary)">
            This session&apos;s agent asks to read the notes of schedule{" "}
            <b className="font-medium text-(--color-text-primary)">{card.scheduleName}</b>. Allow covers this
            schedule only, for this session.
          </div>
          {error && (
            <div role="alert" className="mt-2 text-xs text-(--color-error)">
              {error}
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button disabled={busy !== null} onClick={() => { void decide("allow"); }}>
              Allow for this session
            </Button>
            <Button variant="ghost" disabled={busy !== null} onClick={() => { void decide("deny"); }}>
              Deny
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
