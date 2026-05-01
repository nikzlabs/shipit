// eslint-disable-next-line no-restricted-imports -- useEffect: editor lifecycle, draft load on open, useRef: Monaco editor ref
import { useMemo, useEffect, useRef, useCallback, useState } from "react";
import { XIcon, PaperPlaneTiltIcon, RobotIcon, CaretDownIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog.js";
import { Button } from "./ui/button.js";
import { MarkdownSectionComments } from "./MarkdownSectionComments.js";
import type { SectionCommentData } from "./MarkdownSectionComments.js";
import { useFileReviewStore } from "../stores/file-review-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { createCommentWidgetManager } from "./MonacoCommentWidgets.js";
import type { CommentWidgetManager, LineCommentLike } from "./MonacoCommentWidgets.js";
import type { FilePreviewType } from "../utils/file-preview-type.js";
import type { ReviewComment, FileReview } from "../../server/shared/types.js";
import type * as MonacoEditor from "monaco-editor";

export interface FilePreviewAction {
  label: string;
  onClick: () => void;
  variant?: "primary" | "default";
}

export interface FilePreviewSibling {
  /** Full file path (matches the modal's `filePath` when this tab is active). */
  path: string;
  /** Short label shown in the tab strip (e.g. "Plan", "Checklist"). */
  label: string;
}

export interface FilePreviewModalProps {
  filePath: string;
  content: string | null;
  fileType: FilePreviewType;
  actions?: FilePreviewAction[];
  /**
   * Optional sibling docs in the same directory. When more than one is
   * provided, the modal renders a tab strip in the header. The active tab is
   * the entry whose `path` equals `filePath`.
   */
  siblings?: FilePreviewSibling[];
  /**
   * Called when the user clicks a sibling tab. The caller is expected to
   * load the new file (e.g. via `openPreview`) — the modal stays open and
   * its content swaps via the parent-driven `filePath`/`content` props.
   */
  onSwitchSibling?: (path: string) => void;
  onClose: () => void;
  /**
   * Called after the user clicks Send. Receives the prompt the server already
   * built from the (now-sent) review. Caller dispatches the prompt via the
   * existing `send_message` flow.
   */
  onSendComments?: (prompt: string) => void;
}

/** Map file extensions to Monaco language IDs. */
function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript",
    js: "javascript", jsx: "javascript",
    mjs: "javascript", cjs: "javascript",
    json: "json", jsonc: "json",
    html: "html", htm: "html",
    css: "css", scss: "scss", less: "less",
    md: "markdown", mdx: "markdown",
    py: "python",
    rs: "rust",
    go: "go",
    java: "java",
    c: "c", h: "c",
    cpp: "cpp", hpp: "cpp", cc: "cpp",
    yaml: "yaml", yml: "yaml",
    toml: "ini",
    xml: "xml", svg: "xml",
    sh: "shell", bash: "shell", zsh: "shell",
    sql: "sql",
    graphql: "graphql", gql: "graphql",
    dockerfile: "dockerfile",
  };
  const name = filePath.split("/").pop()?.toLowerCase() ?? "";
  if (name === "dockerfile") return "dockerfile";
  if (name === "makefile") return "makefile";
  return map[ext] ?? "plaintext";
}

// ---------- Code editor with line comments ----------

function CodeEditor({
  filePath,
  content,
  sessionId,
  comments,
}: {
  filePath: string;
  content: string;
  sessionId: string;
  comments: ReviewComment[];
}) {
  const editorRef = useRef<HTMLDivElement>(null);
  const managerRef = useRef<CommentWidgetManager | null>(null);
  const editorInstanceRef = useRef<MonacoEditor.editor.IStandaloneCodeEditor | null>(null);

  const addLineComment = useFileReviewStore((s) => s.addLineComment);
  const editComment = useFileReviewStore((s) => s.editComment);
  const deleteComment = useFileReviewStore((s) => s.deleteComment);

  const lineComments = useMemo<LineCommentLike[]>(() => {
    return comments
      .filter((c): c is Extract<ReviewComment, { kind: "line" }> => c.kind === "line")
      .map((c) => ({ id: c.id, kind: "line", line: c.line, text: c.text }));
  }, [comments]);

  // eslint-disable-next-line no-restricted-syntax -- Monaco lifecycle (createEditor + cleanup)
  useEffect(() => {
    if (!editorRef.current) return;
    let disposed = false;

    // eslint-disable-next-line no-restricted-syntax -- dynamic import for code splitting
    void import("monaco-editor").then((monaco) => {
      if (disposed || !editorRef.current) return;

      const editor = monaco.editor.create(editorRef.current, {
        value: content,
        language: getLanguageFromPath(filePath),
        theme: "vs-dark",
        readOnly: true,
        minimap: { enabled: false },
        lineNumbers: "on",
        glyphMargin: true,
        folding: false,
        scrollBeyondLastLine: false,
        fontSize: 12,
        automaticLayout: true,
      });

      editorInstanceRef.current = editor;

      managerRef.current = createCommentWidgetManager(editor, {
        filePath,
        onAddComment: (line, text) => {
          void addLineComment(sessionId, filePath, line, text);
        },
        onEditComment: (id, text) => {
          void editComment(sessionId, filePath, id, text);
        },
        onDeleteComment: (id) => {
          void deleteComment(sessionId, filePath, id);
        },
      });

      managerRef.current.setComments(lineComments);
    });

    return () => {
      disposed = true;
      managerRef.current?.dispose();
      managerRef.current = null;
      editorInstanceRef.current?.dispose();
      editorInstanceRef.current = null;
    };
    // The lineComments dep is intentionally omitted: we sync via the
    // separate effect below to avoid tearing down the editor on every change.
  }, [filePath, content, sessionId, addLineComment, editComment, deleteComment]);

  // Sync comments without rebuilding the editor.
  // eslint-disable-next-line no-restricted-syntax -- syncing widget state with store updates
  useEffect(() => {
    managerRef.current?.setComments(lineComments);
  }, [lineComments]);

  return <div ref={editorRef} className="h-full w-full" />;
}

// ---------- Markdown viewer with section comments ----------

function MarkdownViewer({
  filePath,
  content,
  sessionId,
  comments,
}: {
  filePath: string;
  content: string;
  sessionId: string;
  comments: ReviewComment[];
}) {
  const addSectionComment = useFileReviewStore((s) => s.addSectionComment);
  const editComment = useFileReviewStore((s) => s.editComment);
  const deleteComment = useFileReviewStore((s) => s.deleteComment);

  const sectionComments: SectionCommentData[] = useMemo(() => {
    return comments
      .filter((c): c is Extract<ReviewComment, { kind: "section" }> => c.kind === "section")
      .map((c) => ({
        id: c.id,
        sectionHeading: c.sectionHeading,
        sectionIndex: c.sectionIndex,
        text: c.text,
        source: c.source,
      }));
  }, [comments]);

  const handleAdd = useCallback(
    (sectionHeading: string, sectionIndex: number, text: string) => {
      void addSectionComment(sessionId, filePath, sectionHeading, sectionIndex, text);
    },
    [sessionId, filePath, addSectionComment],
  );

  const handleEdit = useCallback(
    (commentId: string, text: string) => {
      void editComment(sessionId, filePath, commentId, text);
    },
    [sessionId, filePath, editComment],
  );

  const handleDelete = useCallback(
    (commentId: string) => {
      void deleteComment(sessionId, filePath, commentId);
    },
    [sessionId, filePath, deleteComment],
  );

  return (
    <MarkdownSectionComments
      content={content}
      comments={sectionComments}
      onAddComment={handleAdd}
      onEditComment={handleEdit}
      onDeleteComment={handleDelete}
    />
  );
}

// ---------- Past reviews disclosure ----------

function PastReviews({ history }: { history: FileReview[] }) {
  const [expanded, setExpanded] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  if (history.length === 0) return null;

  return (
    <div className="text-xs">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-(--color-text-secondary) hover:text-(--color-text-primary) cursor-pointer"
      >
        <CaretDownIcon
          size={ICON_SIZE.XS}
          className={`transition-transform ${expanded ? "" : "-rotate-90"}`}
        />
        Past reviews ({history.length})
      </button>
      {expanded && (
        <div className="mt-2 space-y-1">
          {history.map((review) => (
            <div key={review.id}>
              <button
                onClick={() => setOpenId(openId === review.id ? null : review.id)}
                className="flex items-center gap-2 w-full text-left px-2 py-1 rounded hover:bg-(--color-bg-hover) cursor-pointer"
              >
                <span className="text-(--color-text-secondary)">
                  {review.sentAt ? new Date(review.sentAt).toLocaleDateString() : "—"}
                </span>
                <span className="text-(--color-text-tertiary)">
                  {review.comments.length} comment{review.comments.length !== 1 ? "s" : ""}
                </span>
              </button>
              {openId === review.id && (
                <div className="ml-4 mt-1 mb-2 space-y-1">
                  {review.comments.map((c) => (
                    <div
                      key={c.id}
                      className={`text-xs p-2 rounded border-l-2 ${
                        c.source === "ai"
                          ? "border-l-purple-400 bg-purple-950/20"
                          : "border-l-blue-400 bg-blue-950/20"
                      }`}
                    >
                      <span className="text-(--color-text-tertiary)">
                        {c.kind === "section"
                          ? `${c.sectionHeading || "(Intro)"}: `
                          : `Line ${c.line}: `}
                      </span>
                      <span className="text-(--color-text-secondary)">{c.text}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Main modal ----------

const EMPTY_HISTORY: FileReview[] = [];

export function FilePreviewModal({
  filePath,
  content,
  fileType,
  actions,
  siblings,
  onSwitchSibling,
  onClose,
  onSendComments,
}: FilePreviewModalProps) {
  const sessionId = useSessionStore((s) => s.sessionId) ?? "";

  // Selectors return stable references across renders so Zustand doesn't
  // treat each render as a state change (infinite-loop footgun).
  const key = sessionId ? `${sessionId}::${filePath}` : null;
  const draft = useFileReviewStore((s) => (key ? s.draftByKey[key] ?? null : null));
  const history = useFileReviewStore((s) =>
    key ? s.historyByKey[key] ?? EMPTY_HISTORY : EMPTY_HISTORY,
  );
  const aiLoading = useFileReviewStore((s) =>
    key ? s.aiLoadingByKey[key] ?? false : false,
  );
  const load = useFileReviewStore((s) => s.load);
  const aiReview = useFileReviewStore((s) => s.aiReview);
  const sendDraft = useFileReviewStore((s) => s.sendDraft);
  const discardEmptyDraft = useFileReviewStore((s) => s.discardEmptyDraft);

  const reviewable = fileType === "markdown" || fileType === "code";

  // Load draft + history when the modal opens for a reviewable file.
  // eslint-disable-next-line no-restricted-syntax -- one-shot fetch tied to (session, file) identity
  useEffect(() => {
    if (!sessionId || !reviewable || content === null) return;
    void load(sessionId, filePath);
  }, [sessionId, filePath, reviewable, content, load]);

  const commentCount = draft?.comments.length ?? 0;
  const showAiReview = reviewable && fileType === "markdown" && !!sessionId && content !== null;
  const canSend = !!onSendComments && commentCount > 0;

  const handleClose = useCallback(() => {
    if (sessionId && reviewable && draft?.comments.length === 0) {
      void discardEmptyDraft(sessionId, filePath);
    }
    onClose();
  }, [sessionId, reviewable, draft, filePath, discardEmptyDraft, onClose]);

  const handleSwitchSibling = useCallback(
    (nextPath: string) => {
      if (nextPath === filePath || !onSwitchSibling) return;
      // Discard an empty draft on the outgoing tab so it doesn't linger,
      // mirroring the close-without-comments behavior.
      if (sessionId && reviewable && draft?.comments.length === 0) {
        void discardEmptyDraft(sessionId, filePath);
      }
      onSwitchSibling(nextPath);
    },
    [filePath, onSwitchSibling, sessionId, reviewable, draft, discardEmptyDraft],
  );

  const handleAiReview = useCallback(() => {
    if (!sessionId) return;
    void aiReview(sessionId, filePath);
  }, [sessionId, filePath, aiReview]);

  const handleSend = useCallback(async () => {
    if (!sessionId || !onSendComments) return;
    const prompt = await sendDraft(sessionId, filePath);
    if (prompt) onSendComments(prompt);
  }, [sessionId, filePath, sendDraft, onSendComments]);

  const comments = draft?.comments ?? [];
  const showSiblingTabs = !!siblings && siblings.length > 1;

  return (
    <Dialog open onOpenChange={(isOpen) => { if (!isOpen) handleClose(); }}>
      <DialogContent className="w-[90vw] max-w-4xl h-[85vh] flex flex-col">
        {/* Header */}
        <div className="border-b border-(--color-border-secondary) shrink-0">
          <div className="flex items-center justify-between px-6 py-4">
            <DialogTitle className="text-sm font-medium text-(--color-text-primary) truncate" title={filePath}>
              {filePath}
            </DialogTitle>
            <div className="flex items-center gap-2 shrink-0 ml-4">
              {showAiReview && (
                <Button variant="secondary" size="sm" onClick={handleAiReview} disabled={aiLoading}>
                  <RobotIcon size={ICON_SIZE.SM} className="mr-1" />
                  {aiLoading ? "Reviewing..." : "AI Review"}
                </Button>
              )}
              {actions?.map((action) => (
                <Button
                  key={action.label}
                  variant={action.variant === "primary" ? "primary" : "secondary"}
                  size="sm"
                  onClick={action.onClick}
                >
                  {action.label}
                </Button>
              ))}
              <button
                onClick={handleClose}
                className="p-1 rounded hover:bg-(--color-bg-hover) text-(--color-text-secondary) hover:text-(--color-text-primary) transition-colors"
                aria-label="Close"
              >
                <XIcon size={ICON_SIZE.MD} />
              </button>
            </div>
          </div>
          {showSiblingTabs && siblings && (
            <div className="flex px-4" role="tablist" aria-label="Related docs">
              {siblings.map((sib) => {
                const active = sib.path === filePath;
                return (
                  <button
                    key={sib.path}
                    role="tab"
                    aria-selected={active}
                    onClick={() => handleSwitchSibling(sib.path)}
                    className={`px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer border-b-2 -mb-px ${
                      active
                        ? "text-(--color-text-primary) border-(--color-accent)"
                        : "text-(--color-text-tertiary) border-transparent hover:text-(--color-text-secondary)"
                    }`}
                  >
                    {sib.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {content === null ? (
            <div className="flex items-center justify-center h-full text-(--color-text-secondary) text-sm">
              Loading...
            </div>
          ) : fileType === "markdown" ? (
            <MarkdownViewer
              filePath={filePath}
              content={content}
              sessionId={sessionId}
              comments={comments}
            />
          ) : fileType === "image" ? (
            <div className="flex items-center justify-center h-full">
              <img
                src={content}
                alt={filePath}
                className="max-w-full max-h-full object-contain rounded-lg"
              />
            </div>
          ) : fileType === "binary" ? (
            <div className="flex items-center justify-center h-full text-(--color-text-secondary) text-sm">
              Binary file — cannot display.
            </div>
          ) : (
            <CodeEditor
              filePath={filePath}
              content={content}
              sessionId={sessionId}
              comments={comments}
            />
          )}
        </div>

        {/* Footer — review controls */}
        {reviewable && content !== null && (commentCount > 0 || history.length > 0) && (
          <div className="flex items-center justify-between px-6 py-3 border-t border-(--color-border-secondary) bg-(--color-bg-elevated) shrink-0 gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <span className="text-xs text-(--color-text-secondary) whitespace-nowrap">
                {commentCount > 0
                  ? `${commentCount} comment${commentCount !== 1 ? "s" : ""} — draft`
                  : "no draft comments"}
              </span>
              <PastReviews history={history} />
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button variant="ghost" size="sm" onClick={handleClose}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" onClick={handleSend} disabled={!canSend}>
                <PaperPlaneTiltIcon size={ICON_SIZE.SM} className="mr-1" />
                Send {commentCount > 0 ? `${commentCount} comment${commentCount !== 1 ? "s" : ""}` : "Comments"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
