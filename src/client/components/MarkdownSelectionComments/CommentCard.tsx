import { useState } from "react";
import { PencilSimpleIcon, TrashIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";
import { CommentInput } from "./CommentInput.js";
import type { SelectionCommentData } from "./types.js";

export function CommentCard({
  comment,
  showQuote,
  onEdit,
  onDelete,
  readOnly = false,
}: {
  comment: SelectionCommentData;
  showQuote: boolean;
  onEdit: (commentId: string, text: string) => void;
  onDelete: (commentId: string) => void;
  readOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);

  const isAi = comment.source === "ai";
  const borderColor = isAi ? "border-l-purple-400" : "border-l-blue-400";
  const bgColor = isAi ? "bg-purple-950/30" : "bg-blue-950/30";

  if (editing) {
    return (
      <CommentInput
        initialText={comment.text}
        quotedText={comment.quotedText}
        onSubmit={(text) => {
          onEdit(comment.id, text);
          setEditing(false);
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  return (
    <div className={`mt-2 mb-3 ml-4 border-l-2 ${borderColor} ${bgColor} rounded-r-lg p-3 group/comment`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          {isAi && (
            <span className="text-[10px] font-semibold uppercase tracking-wider text-purple-400 mb-1 block">
              AI
            </span>
          )}
          {showQuote && comment.quotedText && (
            <blockquote className="mb-2 border-l-2 border-(--color-border-secondary) pl-2 text-xs text-(--color-text-secondary) italic line-clamp-3">
              {comment.quotedText}
            </blockquote>
          )}
          <p className="text-sm text-(--color-text-primary) whitespace-pre-wrap">{comment.text}</p>
        </div>
        {!readOnly && (
          <div className="flex gap-1 shrink-0 opacity-0 group-hover/comment:opacity-100 transition-opacity">
            <button
              onClick={() => setEditing(true)}
              className="p-1 rounded hover:bg-(--color-bg-hover) text-(--color-text-tertiary) hover:text-(--color-text-primary)"
              title="Edit"
            >
              <PencilSimpleIcon size={ICON_SIZE.SM} />
            </button>
            <button
              onClick={() => onDelete(comment.id)}
              className="p-1 rounded hover:bg-(--color-bg-hover) text-(--color-text-tertiary) hover:text-(--color-error)"
              title="Delete"
            >
              <TrashIcon size={ICON_SIZE.SM} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
