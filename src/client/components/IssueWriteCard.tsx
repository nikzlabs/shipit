import type { KeyboardEvent } from "react";
import {
  ArrowUUpLeftIcon,
  ChatCircleIcon,
  CheckCircleIcon,
  FlagIcon,
  PencilSimpleIcon,
  PlusCircleIcon,
  TagIcon,
  UserCircleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import { useIssueWriteStore } from "../stores/issue-write-store.js";
import { useIssuesStore } from "../stores/issues-store.js";
import type { TrackerId, IssueWriteVerb } from "../../server/shared/types.js";

export interface IssueWriteCardProps {
  cardId: string;
  onUndo?: (cardId: string) => void;
  onOpen?: (ref: {
    tracker: TrackerId;
    identifier: string;
    title?: string;
    url?: string;
    anchorCommentId?: string;
  }) => void;
}

const VERB_LABEL: Record<IssueWriteVerb, string> = {
  comment: "Commented on",
  "comment-edit": "Edited a comment on",
  edit: "Edited",
  status: "Set status of",
  assignee: "Assigned",
  create: "Created",
  label: "Created label",
  "label-edit": "Edited label",
};

function VerbIcon({ verb }: { verb: IssueWriteVerb }) {
  const size = ICON_SIZE.SM;
  switch (verb) {
    case "comment":
      return <ChatCircleIcon size={size} weight="fill" />;
    case "comment-edit":
      return <ChatCircleIcon size={size} />;
    case "edit":
      return <PencilSimpleIcon size={size} />;
    case "status":
      return <FlagIcon size={size} />;
    case "assignee":
      return <UserCircleIcon size={size} />;
    case "create":
      return <PlusCircleIcon size={size} weight="fill" />;
    case "label":
      return <TagIcon size={size} weight="fill" />;
    case "label-edit":
      return <TagIcon size={size} />;
  }
}

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

  const changeLine = (() => {
    if (!content) return null;
    if ((card.verb === "comment" || card.verb === "comment-edit") && content.comment) {
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
    if (card.verb === "label-edit" && (content.label || content.attrs)) {
      return (
        <div className="space-y-0.5">
          {content.label && (
            <div>
              <span className="text-(--color-text-tertiary)">name </span>
              <Delta before={content.label.before} after={content.label.after} />
            </div>
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

  const anchorCommentId =
    card.undo.kind === "comment" || card.undo.kind === "comment-edit" ? card.undo.commentId : undefined;

  const isLabelCard = card.verb === "label" || card.verb === "label-edit";

  // Resolve tracker names at use time; keep the recorded destination as fallback.
  const openIssue = () => {
    const repointed = card.trackerName
      ? useIssuesStore.getState().trackers.find((t) => t.name === card.trackerName)
      : undefined;
    onOpen?.({
      tracker: repointed?.id ?? card.tracker,
      identifier: card.identifier,
      ...(card.title ? { title: card.title } : {}),
      ...(card.url ? { url: card.url } : {}),
      ...(anchorCommentId ? { anchorCommentId } : {}),
    });
  };

  return (
    <div
      data-testid="issue-write-card"
      {...(isLabelCard
        ? {}
        : {
            role: "button",
            tabIndex: 0,
            onClick: openIssue,
            onKeyDown: (e: KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                openIssue();
              }
            },
            title: `Open ${card.identifier} in ShipIt`,
            "aria-label": `Open ${card.identifier} in ShipIt`,
          })}
      className={`w-full text-left rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) px-3 py-2.5 text-xs transition-colors focus:outline-none ${isLabelCard ? "" : "cursor-pointer hover:bg-(--color-bg-hover) focus-visible:ring-1 focus-visible:ring-(--color-accent)"} ${undone ? "opacity-70" : ""}`}
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

      {!undone && card.title && (
        <div className="pl-[26px] mt-0.5 text-(--color-text-tertiary) truncate">{card.title}</div>
      )}

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
