/**
 * IssueWriteCard — inline do-then-surface provenance card for an agent issue
 * write (docs/177, redesigned docs/189).
 *
 * Rendered at the chat position where the agent's `shipit issue` write landed.
 * The write has ALREADY happened — this card is the review surface (consistent
 * with how ShipIt treats commits / PR creation, not a per-action gate).
 *
 * Layout (docs/189): the card leads with the issue and surfaces the actual
 * change, not just the verb.
 *   - Line 1 — an explicit verb word ("Commented on" / "Edited" / "Set status
 *     of" / "Assigned") + the bold identifier (once, no duplicate).
 *   - A faint issue title under line 1, so you know *which* issue without the
 *     link-out.
 *   - Line 2 — the verb-specific change: a comment-body preview, a title /
 *     status delta, or the new assignee.
 *
 * The whole card is the open affordance — clicking it (or Enter/Space when
 * focused) opens the issue in ShipIt's inline detail view, so there is no
 * separate open glyph. Undo is the one nested action; it stops propagation so
 * it doesn't also open the issue. (Anchoring to the specific comment inside the
 * detail view is a follow-up — the inline view doesn't render comments yet.)
 *
 * The authorship line ("by the ShipIt agent (workspace token)") is gone: the
 * card is self-evidently the agent's (it lives in the agent's transcript and
 * carries an Undo), so spelling out the backing identity added nothing
 * actionable. The `attribution` field stays in the data model but is no longer
 * rendered.
 *
 * Lifecycle (from the issue-write store, keyed by cardId): available → undoing
 * → undone | (failed shows the error and re-offers Undo).
 */

import {
  ArrowUUpLeftIcon,
  ChatCircleIcon,
  CheckCircleIcon,
  FlagIcon,
  PencilSimpleIcon,
  PlusCircleIcon,
  UserCircleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import { useIssueWriteStore } from "../stores/issue-write-store.js";
import type { TrackerId, IssueWriteVerb } from "../../server/shared/types.js";

export interface IssueWriteCardProps {
  cardId: string;
  onUndo?: (cardId: string) => void;
  /** Open the inline detail view for this issue (docs/189). */
  onOpen?: (ref: { tracker: TrackerId; identifier: string; title?: string; url?: string }) => void;
}

/** The explicit verb word that leads line 1. `Set status of`, not `Moved`. */
const VERB_LABEL: Record<IssueWriteVerb, string> = {
  comment: "Commented on",
  edit: "Edited",
  status: "Set status of",
  assignee: "Assigned",
  create: "Created",
};

/** Per-verb icon. The comment gets a filled bubble so the common write pops. */
function VerbIcon({ verb }: { verb: IssueWriteVerb }) {
  const size = ICON_SIZE.SM;
  switch (verb) {
    case "comment":
      return <ChatCircleIcon size={size} weight="fill" />;
    case "edit":
      return <PencilSimpleIcon size={size} />;
    case "status":
      return <FlagIcon size={size} />;
    case "assignee":
      return <UserCircleIcon size={size} />;
    case "create":
      return <PlusCircleIcon size={size} weight="fill" />;
  }
}

/** A `before → after` delta: the prior value struck through, the new one plain. */
function Delta({ before, after }: { before: string; after: string }) {
  return (
    <span className="tabular-nums">
      <span className="line-through text-(--color-text-tertiary)">{before}</span>
      <span className="text-(--color-text-tertiary) mx-1.5">→</span>
      <span className="text-(--color-text-primary)">{after}</span>
    </span>
  );
}

export function IssueWriteCard({ cardId, onUndo, onOpen }: IssueWriteCardProps) {
  const card = useIssueWriteStore((s) => s.cards[cardId]);
  if (!card) return null;

  const undone = card.undoState === "undone";
  const undoing = card.undoState === "undoing";
  const failed = card.undoState === "failed";

  const content = card.content;
  const isUnassign = card.verb === "assignee" && content?.assignee === null;
  const verbLabel = isUnassign ? "Unassigned" : VERB_LABEL[card.verb];

  // Line 2 — the actual change, verb-specific. Absent on a create (no "before")
  // and on a labels/priority-only edit that only sets `attrs`.
  const changeLine = (() => {
    if (!content) return null;
    if (card.verb === "comment" && content.comment) {
      return (
        <blockquote className="border-l-2 border-(--color-border-secondary) pl-2 text-(--color-text-secondary) line-clamp-2">
          {content.comment}
        </blockquote>
      );
    }
    if (card.verb === "edit" && (content.title || content.descriptionChanged || content.attrs)) {
      return (
        <div className="space-y-0.5">
          {content.title && (
            <div>
              <span className="text-(--color-text-tertiary)">title </span>
              <Delta before={content.title.before} after={content.title.after} />
            </div>
          )}
          {content.descriptionChanged && (
            <div className="text-(--color-text-tertiary)">description updated</div>
          )}
          {content.attrs && <div className="text-(--color-text-tertiary)">{content.attrs}</div>}
        </div>
      );
    }
    if (card.verb === "status" && content.status) {
      return <Delta before={content.status.from} after={content.status.to} />;
    }
    if (card.verb === "assignee" && content.assignee) {
      return (
        <span>
          <span className="text-(--color-text-tertiary)">→ </span>
          <span className="text-(--color-text-primary)">{content.assignee}</span>
        </span>
      );
    }
    return null;
  })();

  // The whole card opens the issue inline. Derive the lookup id from the
  // display identifier (uniform across trackers) rather than `card.issueId`,
  // which for GitHub is the undo target, not a valid `getIssue` key.
  const openIssue = () =>
    onOpen?.({
      tracker: card.tracker,
      identifier: card.identifier,
      ...(card.title ? { title: card.title } : {}),
      ...(card.url ? { url: card.url } : {}),
    });

  return (
    <div
      data-testid="issue-write-card"
      role="button"
      tabIndex={0}
      onClick={openIssue}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openIssue();
        }
      }}
      title={`Open ${card.identifier} in ShipIt`}
      aria-label={`Open ${card.identifier} in ShipIt`}
      className={`w-full text-left rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) px-3 py-2.5 text-xs cursor-pointer transition-colors hover:bg-(--color-bg-hover) focus:outline-none focus-visible:ring-1 focus-visible:ring-(--color-accent) ${undone ? "opacity-70" : ""}`}
    >
      <div className="flex items-center gap-2">
        <span className={`shrink-0 ${undone ? "text-(--color-text-tertiary)" : "text-(--color-accent)"}`}>
          {undone ? <CheckCircleIcon size={ICON_SIZE.SM} weight="fill" /> : <VerbIcon verb={card.verb} />}
        </span>

        <div className="min-w-0 flex-1 text-(--color-text-primary)">
          {undone ? (
            <span className="text-(--color-text-tertiary)">
              <span className="line-through">
                {verbLabel} {card.identifier}
              </span>{" "}
              · undone
            </span>
          ) : (
            <span>
              <span className="text-(--color-text-secondary)">{verbLabel}</span>{" "}
              <span className="font-semibold">{card.identifier}</span>
            </span>
          )}
        </div>

        {!undone && (
          <Button
            variant="ghost"
            size="md"
            // Stop the click from also opening the issue (the card is the open
            // target); Undo is the one nested action.
            onClick={(e) => {
              e.stopPropagation();
              onUndo?.(cardId);
            }}
            disabled={undoing}
            className="shrink-0"
          >
            <ArrowUUpLeftIcon size={ICON_SIZE.XS} />
            {undoing ? "Undoing…" : failed ? "Retry undo" : "Undo"}
          </Button>
        )}
      </div>

      {/* Faint issue title — which issue, without the link-out. Hidden once
          undone, where line 1 collapses to the struck-through summary. */}
      {!undone && card.title && (
        <div className="pl-[26px] mt-0.5 text-(--color-text-tertiary) truncate">{card.title}</div>
      )}

      {/* Line 2 — the actual change. */}
      {!undone && changeLine && (
        <div className="pl-[26px] mt-1.5 leading-relaxed">{changeLine}</div>
      )}

      {failed && card.errorMessage && (
        <div className="pl-[26px] mt-1.5 flex items-start gap-1 text-(--color-error)">
          <WarningIcon size={ICON_SIZE.XS} weight="fill" className="mt-0.5 shrink-0" />
          <span>Undo failed: {card.errorMessage}</span>
        </div>
      )}
    </div>
  );
}
