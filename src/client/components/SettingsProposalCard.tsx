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
 * A prose value gets a third shape in place of the two chips (req 9): the card
 * says a change is proposed and how big it is, and the change itself is read in
 * a dialog the card opens. Chips cannot carry the user's own instructions, and
 * refusing every realistic change to them is what that limitation used to mean —
 * but pages of their own text do not belong in the scrollback either.
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

import { useState } from "react";
import {
  ArrowsOutSimpleIcon,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.js";
import { Spinner } from "./Spinner.js";
import type {
  SettingsProposalCard as SettingsProposalCardData,
  SettingsProposalDiffLine,
  SettingsProposalPhase,
  SettingsProposalTextChange,
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
 *
 * Both lines, never one instead of the other: they answer different questions.
 * The server's own detail is about the write ("the entry is off the list"), and
 * the effect is about this session ("its containment was fixed at start"), so
 * letting the first hide the second loses the half the user is usually
 * unblocking.
 */
function subLines(card: SettingsProposalCardData): string[] {
  const lines = [card.outcomeDetail, card.effect?.state !== "live" ? card.effect?.detail : undefined]
    .filter((line): line is string => Boolean(line));
  if (lines.length > 0) return lines;
  const standard = STANDARD_DETAIL[card.phase];
  return standard ? [standard] : [];
}

const DIFF_TONE: Record<SettingsProposalDiffLine["kind"], string> = {
  added: "bg-(--color-success)/10 text-(--color-success)",
  removed: "bg-(--color-error)/10 text-(--color-error)",
  context: "text-(--color-text-secondary)",
};

const DIFF_MARK: Record<SettingsProposalDiffLine["kind"], string> = {
  added: "+",
  removed: "−",
  context: " ",
};

/**
 * Colour and a `+`/`−` glyph are the whole distinction on screen, so a reader
 * that reports neither would hear "Always run the tests" and "Never run the
 * tests" with nothing saying which one Apply writes.
 */
const DIFF_LABEL: Partial<Record<SettingsProposalDiffLine["kind"], string>> = {
  added: "Added:",
  removed: "Removed:",
};

function sizeOf(side: { chars: number; lines: number }): string {
  return `${side.chars.toLocaleString()} characters, ${side.lines.toLocaleString()} ${
    side.lines === 1 ? "line" : "lines"}`;
}

/**
 * The whole before and the whole after, interleaved — full context, so this is
 * not a sample of what Apply would write.
 *
 * Three things about it are load-bearing rather than styling. It **scrolls
 * inside a bounded region**, so no length of proposed value outgrows the dialog.
 * Its lines are **plain text**, never markdown, so a heading or a link written
 * into the value cannot render as ShipIt's own chrome. And each changed line
 * **says which it is**, because colour and an `aria-hidden` glyph are the whole
 * distinction on screen.
 */
function DiffLines({ change }: { change: SettingsProposalTextChange }) {
  return (
    <pre
      tabIndex={0}
      aria-label="Proposed text, as a diff"
      className="max-h-[60vh] overflow-auto rounded border border-(--color-border-secondary) bg-(--color-bg-tertiary) p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words"
    >
      {change.lines.map((line, index) => (
        <div key={index} className={`flex ${DIFF_TONE[line.kind]}`}>
          {DIFF_LABEL[line.kind] && <span className="sr-only">{DIFF_LABEL[line.kind]} </span>}
          <span className="mr-2 shrink-0 select-none opacity-50" aria-hidden>
            {DIFF_MARK[line.kind]}
          </span>
          <span className="min-w-0 flex-1">{line.text || " "}</span>
        </div>
      ))}
    </pre>
  );
}

/**
 * A prose change on the card: ShipIt's own summary of it, and the control that
 * opens it (docs/299-agent-settings-access req 9).
 *
 * The change itself is **not** in the transcript. An instructions rewrite is
 * pages of the user's own text, and the scrollback is where their conversation
 * lives — so the card says a change is proposed and how big it is, and the
 * reading happens in a dialog. The counts are the server's, so a value padded
 * with blank lines still reports its bulk here rather than hiding it behind a
 * button that looks cheap to skip.
 */
function TextChange({ change, label }: { change: SettingsProposalTextChange; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="settings-proposal-text-change">
      <span className="text-xs text-(--color-text-tertiary)">
        {sizeOf(change.before)} <span aria-hidden>→</span> {sizeOf(change.after)}
      </span>
      <span className="text-xs text-(--color-success)">+{change.added}</span>
      <span className="text-xs text-(--color-error)">−{change.removed}</span>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <ArrowsOutSimpleIcon size={ICON_SIZE.XS} aria-hidden />
        Review the change
      </Button>
      {open && (
        <Dialog open onOpenChange={(next) => { if (!next) setOpen(false); }}>
          <DialogContent className="flex max-h-[80vh] w-[min(90vw,56rem)] flex-col">
            <DialogHeader className="flex-col items-start gap-0.5">
              <DialogTitle>{label}</DialogTitle>
              <DialogDescription>
                {sizeOf(change.before)} → {sizeOf(change.after)} · +{change.added} −{change.removed}
              </DialogDescription>
            </DialogHeader>
            <div className="min-h-0 flex-1 overflow-auto p-4">
              <DiffLines change={change} />
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

export function SettingsProposalCard({ card, onDecide }: SettingsProposalCardProps) {
  if (card.phase !== "pending") {
    const { icon: Icon, tone, headline } = RESOLVED[card.phase];
    const details = subLines(card);
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
        {details.map((detail) => (
          <span key={detail} className="block w-full pl-6 text-xs text-(--color-text-tertiary)">
            {detail}
          </span>
        ))}
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
            {card.textChange ? (
              <TextChange change={card.textChange} label={card.label} />
            ) : (
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
            )}
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
