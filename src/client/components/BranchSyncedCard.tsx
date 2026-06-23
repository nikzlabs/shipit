/**
 * BranchSyncedCard — inline record that a manual "Sync with <base>" rebased the
 * session branch onto `origin/<base>` and/or fast-forwarded the session clone's
 * local `<base>` ref (docs/221).
 *
 * Unlike the transient rebase banner/toast, this is durable scrollback: a lasting
 * record that the sync happened, with the concrete `was → now` SHAs for both the
 * branch and the local base for auditability. The card has NO lifecycle (no undo)
 * — the full payload arrives on the chat message and the component renders
 * straight from props (no store). Per CLAUDE.md §2 (inline beats link-out) there
 * are no GitHub links.
 */

import { ArrowsClockwiseIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import type { BranchSyncedCard as BranchSyncedCardData } from "../../server/shared/types.js";

export interface BranchSyncedCardProps {
  card: BranchSyncedCardData;
}

/** Short, git-style 7-char SHA. */
function short(sha: string): string {
  return sha.slice(0, 7);
}

/** A `label  was <a> → now <b>` provenance row. */
function MoveRow({ label, from, to, suffix }: { label: string; from: string; to: string; suffix?: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-(--color-text-secondary)">{label}</span>
      <span>was </span>
      <span className="font-mono">{short(from)}</span>
      <span aria-hidden>→</span>
      <span>now </span>
      <span className="font-mono">{short(to)}</span>
      {suffix ? <span className="text-(--color-text-tertiary)">{suffix}</span> : null}
    </span>
  );
}

export function BranchSyncedCard({ card }: BranchSyncedCardProps) {
  const headMoved = !!card.headFromSha && !!card.headToSha && card.headFromSha !== card.headToSha;
  const baseMoved = card.baseFromSha !== null && card.baseFromSha !== card.baseToSha;

  return (
    <div
      data-testid="branch-synced-card"
      className="w-full rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) overflow-hidden text-xs"
    >
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <span className="shrink-0 mt-0.5 grid place-items-center w-7 h-7 rounded-lg bg-(--color-accent-subtle) text-(--color-accent) border border-(--color-border-secondary)">
          <ArrowsClockwiseIcon size={ICON_SIZE.SM} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-medium text-(--color-text-primary)">
            Synced with <code className="px-1.5 py-0.5 rounded bg-(--color-bg-tertiary)">{card.base}</code>
          </div>
          <div className="mt-1 text-(--color-text-secondary)">
            {headMoved ? (
              <>
                Rebased this branch onto the latest{" "}
                <code className="px-1.5 py-0.5 rounded bg-(--color-bg-tertiary)">{card.base}</code>
                {card.forcePushed ? " and pushed" : ""}.
              </>
            ) : (
              <>
                Updated your local{" "}
                <code className="px-1.5 py-0.5 rounded bg-(--color-bg-tertiary)">{card.base}</code> to the latest{" "}
                <code className="px-1.5 py-0.5 rounded bg-(--color-bg-tertiary)">origin/{card.base}</code>.
              </>
            )}
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-1 px-3 pb-2.5 pl-[3.25rem] text-(--color-text-tertiary)">
        {headMoved && <MoveRow label="branch" from={card.headFromSha} to={card.headToSha} />}
        {baseMoved && (
          <MoveRow label={card.base} from={card.baseFromSha as string} to={card.baseToSha} suffix={`(origin/${card.base})`} />
        )}
      </div>
    </div>
  );
}
