// eslint-disable-next-line no-restricted-imports -- useEffect: editor lifecycle, draft load on open, useRef: Monaco editor ref
import { useMemo, useEffect, useRef, useCallback, useState } from "react";
import { XIcon, PaperPlaneTiltIcon, RobotIcon, CaretDownIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog.js";
import { Button } from "./ui/button.js";
import { MarkdownSelectionComments } from "./MarkdownSelectionComments.js";
import type { SelectionCommentData } from "./MarkdownSelectionComments.js";
import { useFileReviewStore } from "../stores/file-review-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { createCommentWidgetManager } from "./MonacoCommentWidgets.js";
import type { CommentWidgetManager, LineCommentLike } from "./MonacoCommentWidgets.js";
import type { FilePreviewType } from "../utils/file-preview-type.js";
import type {
  AgentReview,
  AgentReviewComment,
  ReviewComment,
  FileReview,
} from "../../server/shared/types.js";
import { composeReviewMessage } from "../utils/compose-review-body.js";
import { WithTooltip } from "./ui/tooltip.js";
import type * as MonacoEditor from "monaco-editor";

/**
 * Payload handed to `onSendComments` when the user submits review comments
 * from this modal or the diff panel. Carries the full prompt the server
 * built plus structured metadata (filePaths + commentCount) so the chat
 * surface can render a "Sent comments" card without re-parsing the prompt.
 */
export interface SendCommentsPayload {
  prompt: string;
  /** Files the comments are anchored to. May contain multiple entries for diffs. */
  filePaths: string[];
  /** Number of comments included in the submission. */
  commentCount: number;
}

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
  /**
   * 1-based line to reveal and highlight when the code view mounts (e.g. from a
   * `path:line` link). Ignored for markdown/image/binary. `null` opens at the top.
   */
  line?: number | null;
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
   * built from the (now-sent) review, plus structured metadata so the chat
   * surface can render a "Sent comments" card without parsing the prompt
   * back. Caller dispatches the prompt via the existing `send_message` flow.
   */
  onSendComments?: (payload: SendCommentsPayload) => void;
  /**
   * docs/125 — called when the user clicks "Ask agent to review". Receives the
   * composed review prompt and the file path to authorize the review tool for.
   * Caller dispatches a `send_review_message` and closes the modal.
   */
  onAskAgentReview?: (prompt: string, filePath: string) => void;
  /**
   * docs/151 — modal display mode. `live` (default) is the normal draft/send
   * surface. `agent-review` opens an immutable snapshot of one agent-authored
   * review: snapshot content, that review's comments only, no draft footer,
   * no Send button.
   */
  mode?: "live" | "agent-review";
  /**
   * docs/151 — the agent review to render when `mode === "agent-review"`.
   * Provides the snapshot content and comments; anchors index into the
   * snapshot, not the live file.
   */
  agentReview?: AgentReview | null;
  /**
   * docs/151 — called when the user clicks "View live file" in agent-review
   * mode. Caller swaps the modal back into the normal `live` surface on the
   * same file (draft state, history, human authoring available there).
   */
  onSwitchToLive?: () => void;
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
  readOnly = false,
  revealLine,
}: {
  filePath: string;
  content: string;
  sessionId: string;
  comments: { id: string; kind: "line" | "selection"; line?: number; text: string }[];
  readOnly?: boolean;
  /** 1-based line to scroll to and briefly highlight once the editor mounts. */
  revealLine?: number;
}) {
  const editorRef = useRef<HTMLDivElement>(null);
  const managerRef = useRef<CommentWidgetManager | null>(null);
  const editorInstanceRef = useRef<MonacoEditor.editor.IStandaloneCodeEditor | null>(null);

  const addLineComment = useFileReviewStore((s) => s.addLineComment);
  const editComment = useFileReviewStore((s) => s.editComment);
  const deleteComment = useFileReviewStore((s) => s.deleteComment);

  const lineComments = useMemo<LineCommentLike[]>(() => {
    return comments
      .filter((c): c is { id: string; kind: "line"; line: number; text: string } =>
        c.kind === "line" && typeof c.line === "number",
      )
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
          if (readOnly) return;
          void addLineComment(sessionId, filePath, line, text);
        },
        onEditComment: (id, text) => {
          if (readOnly) return;
          void editComment(sessionId, filePath, id, text);
        },
        onDeleteComment: (id) => {
          if (readOnly) return;
          void deleteComment(sessionId, filePath, id);
        },
        readOnly,
      });

      managerRef.current.setComments(lineComments);

      // Jump to (and briefly highlight) the requested line, e.g. when opened
      // from a `path:line` link in chat. Clamp to the document so an out-of-range
      // line from a stale reference still lands somewhere sensible.
      if (revealLine && revealLine > 0) {
        const lineCount = editor.getModel()?.getLineCount() ?? revealLine;
        const target = Math.min(revealLine, lineCount);
        editor.revealLineInCenter(target);
        editor.setPosition({ lineNumber: target, column: 1 });
        const decorations = editor.createDecorationsCollection([
          {
            range: new monaco.Range(target, 1, target, 1),
            options: {
              isWholeLine: true,
              className: "shipit-preview-line-highlight",
            },
          },
        ]);
        // Fade the highlight after a moment so it draws the eye without sticking.
        setTimeout(() => {
          if (!disposed) decorations.clear();
        }, 2400);
      }
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
  }, [filePath, content, sessionId, addLineComment, editComment, deleteComment, readOnly, revealLine]);

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
  readOnly = false,
}: {
  filePath: string;
  content: string;
  sessionId: string;
  comments: SelectionCommentData[];
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
    <MarkdownSelectionComments
      content={content}
      comments={comments}
      onAddComment={handleAdd}
      onEditComment={handleEdit}
      onDeleteComment={handleDelete}
      readOnly={readOnly}
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
                        {c.kind === "selection"
                          ? `«${c.quotedText.slice(0, 40)}${c.quotedText.length > 40 ? "…" : ""}»: `
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
  line,
  actions,
  siblings,
  onSwitchSibling,
  onClose,
  onSendComments,
  onAskAgentReview,
  mode = "live",
  agentReview,
  onSwitchToLive,
}: FilePreviewModalProps) {
  const sessionId = useSessionStore((s) => s.sessionId) ?? "";
  const isAgentReviewMode = mode === "agent-review";
  // Agent-busy state: a review is a chat turn, so we can't start one while the
  // agent is mid-turn. The button stays visible but disabled (the composed
  // prompt depends on current draft state, so we don't auto-queue).
  const agentRunning = useSessionStore((s) => s.isLoading);

  // 125 — chat-native AI review is gated on `supportsReview` from the active
  // agent's capabilities. Today the affordance is the existing AI Review
  // button; in Phase 2 it becomes "Ask agent to review." Either way, it only
  // shows when the active agent backend can run the flow. Codex sessions
  // hide the button entirely (not disabled) because the silent prod no-op
  // it produced before is strictly worse than no affordance.
  const activeAgentId = useUiStore((s) => s.activeAgentId);
  const agentList = useUiStore((s) => s.agentList);
  const activeAgentSupportsReview =
    agentList.find((a) => a.id === activeAgentId)?.supportsReview ?? false;

  // Selectors return stable references across renders so Zustand doesn't
  // treat each render as a state change (infinite-loop footgun).
  const key = sessionId ? `${sessionId}::${filePath}` : null;
  const draft = useFileReviewStore((s) => (key ? s.draftByKey[key] ?? null : null));
  const history = useFileReviewStore((s) =>
    key ? s.historyByKey[key] ?? EMPTY_HISTORY : EMPTY_HISTORY,
  );
  const load = useFileReviewStore((s) => s.load);
  const sendDraft = useFileReviewStore((s) => s.sendDraft);
  const discardEmptyDraft = useFileReviewStore((s) => s.discardEmptyDraft);

  const reviewable = fileType === "markdown" || fileType === "code";

  // Load draft + history when the modal opens for a reviewable file. Skip in
  // agent-review mode — that surface is scoped to one immutable review and
  // doesn't show drafts or history.
  // eslint-disable-next-line no-restricted-syntax -- one-shot fetch tied to (session, file) identity
  useEffect(() => {
    if (isAgentReviewMode) return;
    if (!sessionId || !reviewable || content === null) return;
    void load(sessionId, filePath);
  }, [sessionId, filePath, reviewable, content, load, isAgentReviewMode]);

  const commentCount = draft?.comments.length ?? 0;
  // The subagent can usefully review markdown of any size, or code under a cap
  // (binaries/huge generated files get no affordance). 10 KB cap per plan §Surface.
  const reviewableForAgent =
    fileType === "markdown" || (fileType === "code" && (content?.length ?? 0) <= 10 * 1024);
  const showAskReview =
    !isAgentReviewMode
    && reviewable
    && reviewableForAgent
    && !!sessionId
    && content !== null
    && activeAgentSupportsReview
    && !!onAskAgentReview;
  const canSend = !isAgentReviewMode && !!onSendComments && commentCount > 0;

  const handleClose = useCallback(() => {
    // Skip the empty-draft cleanup in agent-review mode — that surface never
    // touches drafts.
    if (!isAgentReviewMode && sessionId && reviewable && draft?.comments.length === 0) {
      void discardEmptyDraft(sessionId, filePath);
    }
    onClose();
  }, [sessionId, reviewable, draft, filePath, discardEmptyDraft, onClose, isAgentReviewMode]);

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

  const handleAskReview = useCallback(() => {
    if (!sessionId || !onAskAgentReview || agentRunning) return;
    const prompt = composeReviewMessage(filePath, draft);
    onAskAgentReview(prompt, filePath);
  }, [sessionId, filePath, onAskAgentReview, agentRunning, draft]);

  const handleSend = useCallback(async () => {
    if (!sessionId || !onSendComments) return;
    const result = await sendDraft(sessionId, filePath);
    if (result) {
      onSendComments({
        prompt: result.prompt,
        filePaths: [result.filePath],
        commentCount: result.commentCount,
      });
    }
  }, [sessionId, filePath, sendDraft, onSendComments]);

  // In agent-review mode, the comments come from the immutable agent_reviews
  // row (snapshot-anchored, no source field). In live mode they come from the
  // current draft.
  const markdownComments: SelectionCommentData[] = useMemo(() => {
    if (isAgentReviewMode) {
      if (!agentReview) return [];
      return agentReview.comments
        .filter((c): c is Extract<AgentReviewComment, { kind: "selection" }> => c.kind === "selection")
        .map((c) => ({
          id: c.id,
          quotedText: c.quotedText,
          contextBefore: c.contextBefore,
          contextAfter: c.contextAfter,
          text: c.text,
          source: "ai" as const,
        }));
    }
    return (draft?.comments ?? [])
      .filter((c): c is Extract<ReviewComment, { kind: "selection" }> => c.kind === "selection")
      .map((c) => ({
        id: c.id,
        quotedText: c.quotedText,
        contextBefore: c.contextBefore,
        contextAfter: c.contextAfter,
        text: c.text,
        source: c.source,
      }));
  }, [isAgentReviewMode, agentReview, draft]);

  const codeComments = useMemo(() => {
    if (isAgentReviewMode) {
      if (!agentReview) return [];
      return agentReview.comments
        .filter((c): c is Extract<AgentReviewComment, { kind: "line" }> => c.kind === "line")
        .map((c) => ({ id: c.id, kind: "line" as const, line: c.line, text: c.text }));
    }
    return (draft?.comments ?? [])
      .filter((c): c is Extract<ReviewComment, { kind: "line" }> => c.kind === "line")
      .map((c) => ({ id: c.id, kind: "line" as const, line: c.line, text: c.text }));
  }, [isAgentReviewMode, agentReview, draft]);

  const showSiblingTabs = !isAgentReviewMode && !!siblings && siblings.length > 1;
  const showFooter =
    !isAgentReviewMode
    && reviewable
    && content !== null
    && (commentCount > 0 || history.length > 0);

  // Header subtitle for agent-review mode: tell the user the content shown is
  // a snapshot from review time, not the live file.
  const snapshotLabel = isAgentReviewMode && agentReview
    ? `Snapshot from ${new Date(agentReview.createdAt).toLocaleString()} — file may have changed since.`
    : null;

  return (
    <Dialog open onOpenChange={(isOpen) => { if (!isOpen) handleClose(); }}>
      <DialogContent className="w-[90vw] max-w-4xl h-[85vh] flex flex-col">
        {/* Header */}
        <div className="border-b border-(--color-border-secondary) shrink-0">
          <div className="flex items-center justify-between px-6 py-4">
            <div className="min-w-0">
              <DialogTitle className="text-sm font-medium text-(--color-text-primary) truncate" title={filePath}>
                {filePath}
              </DialogTitle>
              {snapshotLabel && (
                <div
                  className="mt-0.5 text-[11px] text-(--color-text-tertiary) truncate"
                  data-testid="agent-review-snapshot-label"
                >
                  {snapshotLabel}
                  {onSwitchToLive && (
                    <>
                      {" "}
                      <button
                        type="button"
                        onClick={onSwitchToLive}
                        className="text-(--color-accent) hover:underline cursor-pointer"
                      >
                        View live file
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0 ml-4">
              {showAskReview && (
                <WithTooltip label={agentRunning ? "Wait for the current turn to finish" : "Start a chat review turn"}>
                  <Button variant="secondary" size="sm" onClick={handleAskReview} disabled={agentRunning}>
                    <RobotIcon size={ICON_SIZE.SM} className="mr-1" />
                    Ask agent to review
                  </Button>
                </WithTooltip>
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
            <div
              className="flex px-4 overflow-x-auto overscroll-x-contain"
              role="tablist"
              aria-label="Related docs"
            >
              {siblings.map((sib) => {
                const active = sib.path === filePath;
                return (
                  <button
                    key={sib.path}
                    role="tab"
                    aria-selected={active}
                    onClick={() => handleSwitchSibling(sib.path)}
                    className={`shrink-0 whitespace-nowrap px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer border-b-2 -mb-px ${
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
              comments={markdownComments}
              readOnly={isAgentReviewMode}
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
              comments={codeComments}
              readOnly={isAgentReviewMode}
              revealLine={line ?? undefined}
            />
          )}
        </div>

        {/* Footer — review controls (live mode only) */}
        {showFooter && (
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
