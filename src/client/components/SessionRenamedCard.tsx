

import { PencilSimpleIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import type { SessionRenamedCard as SessionRenamedCardData } from "../../server/shared/types.js";

export interface SessionRenamedCardProps {
  card: SessionRenamedCardData;
}

export function SessionRenamedCard({ card }: SessionRenamedCardProps) {
  return (
    <div
      data-testid="session-renamed-card"
      className="w-full rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) overflow-hidden text-xs"
    >
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <span className="shrink-0 mt-0.5 grid place-items-center w-7 h-7 rounded-lg bg-(--color-accent-subtle) text-(--color-accent) border border-(--color-border-secondary)">
          <PencilSimpleIcon size={ICON_SIZE.SM} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-medium text-(--color-text-primary)">Renamed this session</div>
          <div className="mt-1 text-(--color-text-secondary)">
            The session had moved on from what it was first named after. Rename it yourself any time —
            your name is kept and never changed again.
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-(--color-text-tertiary)">
            <span className="line-through">{card.from}</span>
            <span aria-hidden>→</span>
            <span className="text-(--color-text-primary)">{card.to}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
