// eslint-disable-next-line no-restricted-imports -- useEffect: report edit-mode teardown (unmount) to the parent
import { useState, useCallback, useEffect, useRef } from "react";
import { PencilSimpleIcon, TrashIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";
import { CommentInput } from "./CommentInput.js";
import type { SelectionCommentData } from "./types.js";

export function CommentCard({
  comment,
  showQuote,
  onEdit,
  onDelete,
  onEditingChange,
  readOnly = false,
}: {
  comment: SelectionCommentData;
  showQuote: boolean;
  onEdit: (commentId: string, text: string) => void;
  onDelete: (commentId: string) => void;
  /** Reports the in-place edit form opening/closing so the surface can block
   *  "Send comments" on an unsaved edit. Also fires `false` on unmount. */
  onEditingChange?: (commentId: string, editing: boolean) => void;
  readOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);

  const onEditingChangeRef = useRef(onEditingChange);
  onEditingChangeRef.current = onEditingChange;

  // eslint-disable-next-line no-restricted-syntax -- external sync: clear the parent's editing flag if the card unmounts mid-edit
  useEffect(() => {
    if (!editing) return;
    return () => onEditingChangeRef.current?.(comment.id, false);
  }, [editing, comment.id]);

  const setEditingAndNotify = useCallback(
    (next: boolean) => {
      setEditing(next);
      onEditingChangeRef.current?.(comment.id, next);
    },
    [comment.id],
  );

  if (editing) {
    return (
      <CommentInput
        initialText={comment.text}
        quotedText={comment.quotedText}
        onSubmit={(text) => {
          onEdit(comment.id, text);
          setEditingAndNotify(false);
        }}
        onCancel={() => setEditingAndNotify(false)}
      />
    );
  }

  return (
    <div className="mt-2 mb-3 ml-4 border-l-2 border-l-blue-400 bg-blue-950/30 rounded-r-lg p-3 group/comment">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
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
              onClick={() => setEditingAndNotify(true)}
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
