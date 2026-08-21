/**
 * SessionSettingsChangeCard — inline record that this session's settings changed
 * (docs/279, requirements 7 + 8).
 *
 * A capability grant moving is a trust-boundary change: "when did this sandbox
 * get GitHub access?" is a question the transcript should answer, not one the
 * user has to reconstruct from a toggle's current position. Covers both writers —
 * a sandbox's capability grants and a regular session's network containment mode
 * — because they answer that same question.
 *
 * No lifecycle and no undo (the settings dialog is the override), so the full
 * payload arrives on the chat message and the component renders straight from
 * props (no store). `pendingRestart` is recorded as it was at the moment of the
 * change and is never patched: the card says what happened, and the live "is it
 * applied yet" answer belongs to the dialog.
 */

import { ShieldCheckIcon, PlusCircleIcon, MinusCircleIcon, ClockClockwiseIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import type { SessionSettingsChangeCard as SessionSettingsChangeCardData } from "../../server/shared/types.js";

export interface SessionSettingsChangeCardProps {
  card: SessionSettingsChangeCardData;
}

const TITLES: Record<SessionSettingsChangeCardData["scope"], string> = {
  "sandbox-capabilities": "Sandbox capabilities changed",
  "network-mode": "Network access changed",
};

export function SessionSettingsChangeCard({ card }: SessionSettingsChangeCardProps) {
  return (
    <div
      data-testid="session-settings-change-card"
      className="w-full rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) overflow-hidden text-xs"
    >
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <span className="shrink-0 mt-0.5 grid place-items-center w-7 h-7 rounded-lg bg-(--color-accent-subtle) text-(--color-accent) border border-(--color-border-secondary)">
          <ShieldCheckIcon size={ICON_SIZE.SM} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-medium text-(--color-text-primary)">{TITLES[card.scope]}</div>
          <ul className="mt-1.5 flex flex-col gap-1">
            {card.changes.map((change) => (
              <li key={change.label} className="flex items-center gap-2 text-(--color-text-secondary)">
                <span
                  className={`shrink-0 ${
                    change.granted === undefined
                      ? "text-(--color-text-tertiary)"
                      : change.granted
                        ? "text-(--color-success)"
                        : "text-(--color-text-tertiary)"
                  }`}
                >
                  {change.granted === false
                    ? <MinusCircleIcon size={ICON_SIZE.SM} weight="fill" />
                    : <PlusCircleIcon size={ICON_SIZE.SM} weight={change.granted ? "fill" : "regular"} />}
                </span>
                <span className="text-(--color-text-primary)">{change.label}</span>
                <span className="text-(--color-text-tertiary) line-through">{change.from}</span>
                <span className="text-(--color-text-tertiary)" aria-hidden>→</span>
                <span className="text-(--color-text-primary)">{change.to}</span>
              </li>
            ))}
          </ul>
          {card.pendingRestart && (
            <div
              className="mt-2 flex items-center gap-1.5 text-(--color-text-tertiary)"
              data-testid="session-settings-change-card-pending"
            >
              <ClockClockwiseIcon size={ICON_SIZE.SM} />
              <span>Applied on the next container start.</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
