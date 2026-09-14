/**
 * SettingsProposalCard — one ShipIt setting the agent proposes changing, and the
 * click that is the whole gate (docs/299-agent-settings-access req 4).
 *
 * Two shapes, and the split is the point. **Pending** is a full card: what the
 * setting is, where it lives, what it is now, what it would become, and two
 * buttons. Once the user has acted it **collapses in place** to one muted line
 * that stays in the scrollback — the card is persisted, so a proposal they
 * applied last week is still there, saying so.
 *
 * Everything ShipIt asserts about the change comes from the server: the label,
 * the description and the breadcrumb are the registry's own words, `from` and
 * `to` are the server's own read, and `outcome` is ShipIt's account of what
 * happened. The agent contributes exactly one field, `reason`, which is shown
 * quoted and attributed so it can never read as ShipIt describing the change.
 *
 * Static payload, no store: every phase rides on the message row, so the card
 * renders identically live and after a reload.
 */

import {
  CheckCircleIcon,
  CircleHalfIcon,
  QuestionIcon,
  SlidersHorizontalIcon,
  WarningCircleIcon,
  WarningIcon,
  XCircleIcon,
  type Icon,
} from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import { Spinner } from "./Spinner.js";
import type {
  SettingsProposalCard as SettingsProposalCardData,
  SettingsProposalPhase,
} from "../../server/shared/types.js";

export interface SettingsProposalCardProps {
  card: SettingsProposalCardData;
  onDecide?: (cardId: string, action: "apply" | "dismiss") => void;
}

interface ResolvedLook {
  /** Absent while the apply is in flight, where the shared spinner stands in. */
  icon?: Icon;
  tone: string;
  headline: string;
}

const RESOLVED: Record<Exclude<SettingsProposalPhase, "pending">, ResolvedLook> = {
  applying: { tone: "text-(--color-text-tertiary)", headline: "Applying…" },
  applied: { icon: CheckCircleIcon, tone: "text-(--color-success)", headline: "Applied" },
  partial: { icon: CircleHalfIcon, tone: "text-(--color-warning)", headline: "Partly applied" },
  uncertain: { icon: QuestionIcon, tone: "text-(--color-text-tertiary)", headline: "Result not verified" },
  stale: { icon: WarningIcon, tone: "text-(--color-warning)", headline: "Not applied" },
  refused: { icon: WarningIcon, tone: "text-(--color-warning)", headline: "Not applied" },
  failed: { icon: WarningCircleIcon, tone: "text-(--color-error)", headline: "Failed" },
  dismissed: { icon: XCircleIcon, tone: "text-(--color-text-tertiary)", headline: "Dismissed" },
  unknown: { icon: QuestionIcon, tone: "text-(--color-text-tertiary)", headline: "Outcome unknown" },
};

/** What the line says when the server wrote no `outcome` of its own. */
function standardClause(card: SettingsProposalCardData): string {
  switch (card.phase) {
    case "applied":
      return `${card.label} is ${card.to}`;
    case "stale":
      return "the setting changed after this was proposed";
    case "refused":
      return "the change is no longer valid";
    case "failed":
      return "the change could not be saved";
    case "uncertain":
      return "the write could not confirm what it did";
    case "unknown":
      return "ShipIt restarted while applying this";
    default:
      return card.label;
  }
}

/** The two phases whose sub-line is always the same sentence. */
const STANDARD_DETAIL: Partial<Record<SettingsProposalPhase, string>> = {
  stale: "Its value moved after this card was written. Nothing was applied.",
  unknown: "Check the setting. It is never retried on its own — the write may already have run.",
};

/**
 * A saved value is not always the one ShipIt uses, so an applied card says which
 * — reporting a global allowlist addition as a plain "Applied" would tell the
 * user the host is reachable now, in exactly the case where it is not.
 */
function subLine(card: SettingsProposalCardData): string | undefined {
  if (card.outcomeDetail) return card.outcomeDetail;
  if (card.effect && card.effect.state !== "live") return card.effect.detail;
  return STANDARD_DETAIL[card.phase];
}

export function SettingsProposalCard({ card, onDecide }: SettingsProposalCardProps) {
  if (card.phase !== "pending") {
    const { icon: Icon, tone, headline } = RESOLVED[card.phase];
    const detail = subLine(card);
    return (
      <div
        data-testid="settings-proposal-card"
        data-phase={card.phase}
        className="flex flex-wrap items-center gap-2 rounded-lg border border-(--color-border-primary) bg-(--color-bg-tertiary) px-3 py-2 text-sm text-(--color-text-secondary)"
      >
        {Icon
          ? <Icon size={ICON_SIZE.SM} weight="fill" className={`shrink-0 ${tone}`} aria-hidden />
          : <Spinner size={ICON_SIZE.SM} className={`shrink-0 ${tone}`} />}
        <span>
          <strong className={tone}>{headline}</strong>{" "}
          <span className="text-(--color-text-tertiary)" aria-hidden>·</span>{" "}
          {card.outcome ?? standardClause(card)}
        </span>
        {detail && (
          <span className="block w-full pl-6 text-xs text-(--color-text-tertiary)">{detail}</span>
        )}
      </div>
    );
  }

  return (
    <div
      data-testid="settings-proposal-card"
      data-phase="pending"
      className="rounded-lg border border-(--color-accent)/40 bg-(--color-accent-subtle) px-4 py-3"
    >
      <div className="flex items-start gap-2.5">
        <SlidersHorizontalIcon
          size={ICON_SIZE.MD}
          className="mt-0.5 shrink-0 text-(--color-accent)"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-(--color-text-primary)">Settings change proposed</div>
          <div className="mt-0.5 text-xs text-(--color-text-tertiary)">{card.path}</div>

          <div className="mt-2.5 rounded-md border border-(--color-border-secondary) bg-(--color-bg-primary) px-3 py-2">
            <div className="text-sm font-medium text-(--color-text-primary)">
              {card.label}
              {/* One setting exists once per role, per MCP server, per allowlist
                  entry. Without the instance, two cards proposing opposite
                  changes to different servers read identically, and the only
                  thing telling them apart would be the agent's own reason. */}
              {card.target.item && (
                <span className="ml-1.5 font-normal text-(--color-text-tertiary)">
                  · {card.target.item}
                </span>
              )}
            </div>
            <div className="mt-0.5 text-xs text-(--color-text-secondary)">{card.description}</div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <span
                data-testid="settings-proposal-from"
                className="rounded bg-(--color-bg-tertiary) px-1.5 py-0.5 font-mono text-(--color-text-secondary) line-through decoration-(--color-text-tertiary)"
              >
                {card.from}
              </span>
              <span className="text-(--color-text-tertiary)" aria-hidden>→</span>
              <span
                data-testid="settings-proposal-to"
                className="rounded bg-(--color-success-subtle) px-1.5 py-0.5 font-mono font-semibold text-(--color-success)"
              >
                {card.to}
              </span>
            </div>
            {card.alsoChanges && card.alsoChanges.length > 0 && (
              <div
                data-testid="settings-proposal-also"
                className="mt-2 border-t border-(--color-border-secondary) pt-2"
              >
                <div className="text-[11px] text-(--color-text-tertiary)">Applying this also changes</div>
                {card.alsoChanges.map((change) => (
                  <div
                    key={change.label}
                    data-testid={`settings-proposal-also-${change.label}`}
                    className="mt-1 flex flex-wrap items-center gap-2 text-xs"
                  >
                    <span className="text-(--color-text-secondary)">{change.label}</span>
                    <span className="rounded bg-(--color-bg-tertiary) px-1.5 py-0.5 font-mono text-(--color-text-secondary) line-through decoration-(--color-text-tertiary)">
                      {change.from}
                    </span>
                    <span className="text-(--color-text-tertiary)" aria-hidden>→</span>
                    <span className="rounded bg-(--color-success-subtle) px-1.5 py-0.5 font-mono font-semibold text-(--color-success)">
                      {change.to}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {card.reason && (
            <div className="mt-2.5 border-l-2 border-(--color-border-secondary) pl-2.5 text-xs text-(--color-text-secondary) break-words">
              <span className="block text-[11px] text-(--color-text-tertiary)">The agent’s reason</span>
              {card.reason}
            </div>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            <Button onClick={() => onDecide?.(card.cardId, "apply")}>Apply</Button>
            <Button variant="ghost" onClick={() => onDecide?.(card.cardId, "dismiss")}>
              Dismiss
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
