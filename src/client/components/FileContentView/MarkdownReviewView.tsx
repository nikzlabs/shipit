import { useCallback } from "react";
import { MarkdownSelectionComments } from "../MarkdownSelectionComments.js";
import type { SelectionCommentData } from "../MarkdownSelectionComments.js";
import { useFileReviewStore } from "../../stores/file-review-store.js";

/**
 * Markdown viewer with frontmatter header + selection review comments, shared by
 * the file-viewer dialog and the Present tab (docs/219). Moved verbatim from
 * `FilePreviewModal`'s `MarkdownViewer`. When `readOnly` (a non-workspace
 * artifact, e.g. a `/persist` present file that the review API can't address)
 * the comments render but can't be mutated and the add-button is hidden.
 */
export function MarkdownReviewView({
  filePath,
  content,
  sessionId,
  comments,
  lineComments = [],
  readOnly = false,
}: {
  filePath: string;
  content: string;
  sessionId: string;
  comments: SelectionCommentData[];
  lineComments?: { id: string; line: number; text: string }[];
  readOnly?: boolean;
}) {
  const addSelectionComment = useFileReviewStore((s) => s.addSelectionComment);
  const editComment = useFileReviewStore((s) => s.editComment);
  const deleteComment = useFileReviewStore((s) => s.deleteComment);

  const handleAdd = useCallback(
    (quotedText: string, contextBefore: string, contextAfter: string, text: string) => {
      if (readOnly) return null;
      return addSelectionComment(sessionId, filePath, quotedText, contextBefore, contextAfter, text);
    },
    [sessionId, filePath, addSelectionComment, readOnly],
  );

  const handleEdit = useCallback(
    (commentId: string, text: string) => {
      if (readOnly) return;
      void editComment(sessionId, filePath, commentId, text);
    },
    [sessionId, filePath, editComment, readOnly],
  );

  const handleDelete = useCallback(
    (commentId: string) => {
      if (readOnly) return;
      void deleteComment(sessionId, filePath, commentId);
    },
    [sessionId, filePath, deleteComment, readOnly],
  );

  return (
    <div className="space-y-4">
      {lineComments.length > 0 && (
        <div
          className="rounded-md border border-(--color-border-secondary) bg-(--color-bg-secondary)"
          data-testid="markdown-line-findings"
        >
          <div className="border-b border-(--color-border-secondary) px-3 py-2 text-xs font-medium text-(--color-text-secondary)">
            Source line findings
          </div>
          <div className="divide-y divide-(--color-border-secondary)">
            {lineComments.map((comment) => (
              <div key={comment.id} className="grid grid-cols-[auto_1fr] gap-3 px-3 py-2">
                <span className="font-mono text-[11px] text-(--color-text-tertiary) pt-0.5">
                  L{comment.line}
                </span>
                <p className="text-sm text-(--color-text-primary) whitespace-pre-wrap">
                  {comment.text}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
      <MarkdownSelectionComments
        content={content}
        comments={comments}
        onAddComment={handleAdd}
        onEditComment={handleEdit}
        onDeleteComment={handleDelete}
        readOnly={readOnly}
      />
    </div>
  );
}
