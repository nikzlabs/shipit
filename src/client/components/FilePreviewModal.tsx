// eslint-disable-next-line no-restricted-imports -- useEffect: Escape keydown listener (browser API subscription with cleanup), useRef: Monaco editor ref
import { useMemo, useEffect, useRef, useCallback } from "react";
import { XIcon, PaperPlaneTiltIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Modal } from "./ui/modal.js";
import { Button } from "./ui/button.js";
import { MarkdownSectionComments } from "./MarkdownSectionComments.js";
import type { SectionCommentData } from "./MarkdownSectionComments.js";
import { useCommentStore } from "../stores/comment-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { createCommentWidgetManager } from "./MonacoCommentWidgets.js";
import type { CommentWidgetManager } from "./MonacoCommentWidgets.js";
import type { FilePreviewType } from "../utils/file-preview-type.js";
import type { FileComment } from "../../server/shared/types.js";
import type * as MonacoEditor from "monaco-editor";

export interface FilePreviewAction {
  label: string;
  onClick: () => void;
  variant?: "primary" | "default";
}

export interface FilePreviewModalProps {
  filePath: string;
  content: string | null;
  fileType: FilePreviewType;
  actions?: FilePreviewAction[];
  onClose: () => void;
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

function buildFileCommentsPrompt(comments: FileComment[], fileContents: Map<string, string>): string {
  const byFile = new Map<string, FileComment[]>();
  for (const c of comments) {
    if (!byFile.has(c.filePath)) byFile.set(c.filePath, []);
    byFile.get(c.filePath)!.push(c);
  }

  let prompt = "I have the following comments on the code:\n\n";

  for (const [filePath, fileComments] of byFile) {
    const lines = (fileContents.get(filePath) ?? "").split("\n");

    const lineComments = fileComments
      .filter((c): c is FileComment & { kind: "line" } => c.kind === "line")
      .sort((a, b) => a.line - b.line);

    for (const comment of lineComments) {
      const start = Math.max(0, comment.line - 3);
      const end = Math.min(lines.length, comment.line + 2);
      const snippet = lines.slice(start, end)
        .map((l, i) => {
          const lineNum = start + i + 1;
          const marker = lineNum === comment.line ? "\u2192" : " ";
          return `${marker} ${lineNum} \u2502 ${l}`;
        })
        .join("\n");

      prompt += `**${filePath}:${comment.line}**\n`;
      prompt += `\`\`\`\n${snippet}\n\`\`\`\n`;
      prompt += `Comment: ${comment.text}\n\n`;
    }

    const sectionComments = fileComments
      .filter((c): c is FileComment & { kind: "section" } => c.kind === "section")
      .sort((a, b) => a.sectionIndex - b.sectionIndex);

    for (const comment of sectionComments) {
      const heading = comment.sectionHeading || "(Introduction)";
      prompt += `**${filePath} \u2192 ${heading}**\n`;
      prompt += `Comment: ${comment.text}\n\n`;
    }
  }

  prompt += "Please address each comment.";
  return prompt;
}

function CodeEditor({
  filePath,
  content,
  sessionId,
}: {
  filePath: string;
  content: string;
  sessionId: string;
}) {
  const editorRef = useRef<HTMLDivElement>(null);
  const managerRef = useRef<CommentWidgetManager | null>(null);
  const monacoRef = useRef<typeof MonacoEditor | null>(null);
  const editorInstanceRef = useRef<MonacoEditor.editor.IStandaloneCodeEditor | null>(null);

  const sessionComments = useCommentStore((s) => s.commentsBySession[sessionId]);
  const commentsForFile = useMemo(
    () => (sessionComments ?? []).filter((c) => c.filePath === filePath),
    [sessionComments, filePath],
  );
  const addLineComment = useCommentStore((s) => s.addLineComment);
  const editComment = useCommentStore((s) => s.editComment);
  const deleteComment = useCommentStore((s) => s.deleteComment);

  useEffect(() => {
    if (!editorRef.current) return;
    let disposed = false;

    // eslint-disable-next-line no-restricted-syntax -- dynamic import for code splitting
    void import("monaco-editor").then((monaco) => {
      if (disposed || !editorRef.current) return;
      monacoRef.current = monaco;

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
        onAddComment: (line, text) => addLineComment(sessionId, filePath, line, text),
        onEditComment: (id, text) => editComment(sessionId, id, text),
        onDeleteComment: (id) => deleteComment(sessionId, id),
      });

      managerRef.current.setComments(useCommentStore.getState().getCommentsForFile(sessionId, filePath));
    });

    return () => {
      disposed = true;
      managerRef.current?.dispose();
      managerRef.current = null;
      editorInstanceRef.current?.dispose();
      editorInstanceRef.current = null;
    };
  }, [filePath, content, sessionId, addLineComment, editComment, deleteComment]);

  // Sync comments changes
  useEffect(() => {
    managerRef.current?.setComments(commentsForFile);
  }, [commentsForFile]);

  return <div ref={editorRef} className="h-full w-full" />;
}

function MarkdownViewer({
  filePath,
  content,
  sessionId,
}: {
  filePath: string;
  content: string;
  sessionId: string;
}) {
  const sessionComments = useCommentStore((s) => s.commentsBySession[sessionId]);
  const commentsForFile = useMemo(
    () => (sessionComments ?? []).filter((c) => c.filePath === filePath),
    [sessionComments, filePath],
  );
  const addSectionComment = useCommentStore((s) => s.addSectionComment);
  const editComment = useCommentStore((s) => s.editComment);
  const deleteComment = useCommentStore((s) => s.deleteComment);

  const sectionComments: SectionCommentData[] = useMemo(() => {
    return commentsForFile
      .filter((c) => c.kind === "section")
      .map((c) => ({
        id: c.id,
        sectionHeading: c.kind === "section" ? c.sectionHeading : "",
        sectionIndex: c.kind === "section" ? c.sectionIndex : 0,
        text: c.text,
      }));
  }, [commentsForFile]);

  const handleAddComment = useCallback(
    (sectionHeading: string, sectionIndex: number, text: string) => {
      addSectionComment(sessionId, filePath, sectionHeading, sectionIndex, text);
    },
    [sessionId, filePath, addSectionComment],
  );

  const handleEditComment = useCallback(
    (commentId: string, text: string) => {
      editComment(sessionId, commentId, text);
    },
    [sessionId, editComment],
  );

  const handleDeleteComment = useCallback(
    (commentId: string) => {
      deleteComment(sessionId, commentId);
    },
    [sessionId, deleteComment],
  );

  return (
    <MarkdownSectionComments
      content={content}
      comments={sectionComments}
      onAddComment={handleAddComment}
      onEditComment={handleEditComment}
      onDeleteComment={handleDeleteComment}
    />
  );
}

export function FilePreviewModal({ filePath, content, fileType, actions, onClose, onSendComments }: FilePreviewModalProps) {
  const sessionId = useSessionStore((s) => s.sessionId) ?? "";
  const sessionComments = useCommentStore((s) => s.commentsBySession[sessionId]);
  const allComments = sessionComments ?? [];
  const commentCount = allComments.length;
  const clearComments = useCommentStore((s) => s.clearComments);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleSendComments = useCallback(() => {
    if (commentCount === 0 || !onSendComments) return;

    const fileContents = new Map<string, string>();
    if (content) fileContents.set(filePath, content);

    const prompt = buildFileCommentsPrompt(allComments, fileContents);
    onSendComments(prompt);
    clearComments(sessionId);
  }, [commentCount, onSendComments, allComments, filePath, content, clearComments, sessionId]);

  return (
    <Modal onClose={onClose} className="w-[90vw] max-w-4xl h-[85vh] flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-(--color-border-secondary) shrink-0">
        <h2 className="text-sm font-medium text-(--color-text-primary) truncate" title={filePath}>{filePath}</h2>
        <div className="flex items-center gap-2 shrink-0 ml-4">
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
            onClick={onClose}
            className="p-1 rounded hover:bg-(--color-bg-hover) text-(--color-text-secondary) hover:text-(--color-text-primary) transition-colors"
            aria-label="Close"
          >
            <XIcon size={ICON_SIZE.MD} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {content === null ? (
          <div className="flex items-center justify-center h-full text-(--color-text-secondary) text-sm">
            Loading...
          </div>
        ) : fileType === "markdown" ? (
          <MarkdownViewer filePath={filePath} content={content} sessionId={sessionId} />
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
          <CodeEditor filePath={filePath} content={content} sessionId={sessionId} />
        )}
      </div>

      {/* Comment footer */}
      {onSendComments && commentCount > 0 && (
        <div className="flex items-center justify-between px-6 py-3 border-t border-(--color-border-secondary) bg-(--color-bg-elevated) shrink-0">
          <span className="text-xs text-(--color-text-secondary)">
            {commentCount} comment{commentCount !== 1 ? "s" : ""}
          </span>
          <Button variant="primary" size="sm" onClick={handleSendComments}>
            <PaperPlaneTiltIcon size={ICON_SIZE.SM} className="mr-1" />
            Send {commentCount} comment{commentCount !== 1 ? "s" : ""}
          </Button>
        </div>
      )}
    </Modal>
  );
}
