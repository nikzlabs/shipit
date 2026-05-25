// eslint-disable-next-line no-restricted-imports -- useRef: Monaco editor ref, useEffect: comment sync
import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { DiffEditor } from "@monaco-editor/react";
import type { DiffOnMount } from "@monaco-editor/react";
import { XIcon, PaperPlaneTiltIcon, CaretRightIcon, CaretDownIcon, CaretLeftIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import { useIsMobile } from "../hooks/useMediaQuery.js";
import { useCommentStore } from "../stores/comment-store.js";
import { usePrStore } from "../stores/pr-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { createCommentWidgetManager } from "./MonacoCommentWidgets.js";
import type { CommentWidgetManager, LineCommentLike } from "./MonacoCommentWidgets.js";
import type { FileDiff } from "../../server/shared/types.js";
import type { PrReviewThread } from "../../server/shared/types/github-types.js";
import { buildFileTree, type FileTreeNode } from "./diff-utils.js";
import { DiffTreeNode } from "./DiffTreeNode.js";
import type { SendCommentsPayload } from "./FilePreviewModal.js";

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

export interface TurnDiffData {
  fromCommit: string;
  toCommit: string;
  files: FileDiff[];
  stats: { totalInsertions: number; totalDeletions: number; filesChanged: number };
}

export function githubReviewThreadsToLineComments(threads: PrReviewThread[] | undefined): LineCommentLike[] {
  return (threads ?? [])
    .filter((thread) => thread.path && typeof thread.line === "number")
    .map((thread) => {
      const first = thread.comments[0];
      return {
        id: `github:${thread.id}`,
        kind: "line",
        source: "github",
        filePath: thread.path ?? undefined,
        line: thread.line ?? undefined,
        text: first?.body ?? "",
        author: first?.author,
        createdAt: first?.createdAt,
        isResolved: thread.isResolved,
        isOutdated: thread.isOutdated,
        replies: thread.comments.map((comment) => ({
          id: comment.id,
          author: comment.author,
          body: comment.body,
          createdAt: comment.createdAt,
        })),
      };
    });
}

interface DiffPanelProps {
  diff: TurnDiffData;
  onClose: () => void;
  commitMessage?: string;
  onSendComments?: (payload: SendCommentsPayload) => void;
}

/** Monaco DiffEditor options shared by all file sections. */
const DIFF_EDITOR_OPTIONS = {
  readOnly: true,
  renderSideBySide: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  fontSize: 12,
  lineNumbers: "on" as const,
  folding: false,
  wordWrap: "off" as const,
  renderOverviewRuler: false,
  diffWordWrap: "off" as const,
  glyphMargin: true,
  hideUnchangedRegions: { enabled: true },
  scrollbar: {
    verticalScrollbarSize: 8,
    horizontalScrollbarSize: 8,
    alwaysConsumeMouseWheel: false,
  },
};

export function DiffPanel({ diff, onClose, commitMessage, onSendComments }: DiffPanelProps) {
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<number>>(new Set());
  // Mobile master-detail: on narrow viewports we show either the file list or a
  // single file's diff, not both. Desktop ignores this state entirely.
  const [mobileView, setMobileView] = useState<"list" | "detail">("list");
  const isMobile = useIsMobile();
  const fileSectionRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const editorContainerRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const managersRef = useRef<Map<string, CommentWidgetManager>>(new Map());

  const sessionId = useSessionStore((s) => s.sessionId) ?? "";
  const sessionComments = useCommentStore((s) => s.commentsBySession[sessionId]);
  const prReviewThreads = usePrStore((s) => s.cardBySession[sessionId]?.reviewThreads);
  const allComments = sessionComments ?? [];
  const githubComments = useMemo(
    () => githubReviewThreadsToLineComments(prReviewThreads),
    [prReviewThreads],
  );
  const visibleComments = useMemo(
    () => [...allComments, ...githubComments],
    [allComments, githubComments],
  );
  const commentCount = allComments.length;
  const addLineComment = useCommentStore((s) => s.addLineComment);
  const editComment = useCommentStore((s) => s.editComment);
  const deleteComment = useCommentStore((s) => s.deleteComment);
  const clearComments = useCommentStore((s) => s.clearComments);

  const fileTree = useMemo(() => buildFileTree(diff.files), [diff.files]);

  // Start with all directories expanded
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => {
    const dirs = new Set<string>();
    function collectDirKeys(nodes: FileTreeNode[], depth: number) {
      for (const node of nodes) {
        if (node.children) {
          dirs.add(`dir:${depth}:${node.name}`);
          collectDirKeys(node.children, depth + 1);
        }
      }
    }
    collectDirKeys(fileTree, 0);
    return dirs;
  });

  const toggleDir = useCallback((key: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /** Sidebar click: highlight, expand if collapsed, scroll into view. On
   * mobile, also flips from the file list to the single-file detail view. */
  const handleSelectFile = useCallback((index: number) => {
    setSelectedFileIndex(index);
    setCollapsedFiles((prev) => {
      if (!prev.has(index)) return prev;
      const next = new Set(prev);
      next.delete(index);
      return next;
    });
    setMobileView("detail");
    requestAnimationFrame(() => {
      fileSectionRefs.current.get(index)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, []);

  const toggleFileCollapse = useCallback((index: number) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  // Clean up all comment managers on unmount
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    return () => {
      for (const manager of managersRef.current.values()) {
        manager.dispose();
      }
      managersRef.current.clear();
    };
  }, []);

  // Sync comments to all active managers
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    for (const [filePath, manager] of managersRef.current.entries()) {
      manager.setComments(visibleComments.filter((c) => c.filePath === filePath));
    }
  }, [visibleComments]);

  /** Called when each file's DiffEditor mounts. Sets up auto-height + comments. */
  const handleEditorMount = useCallback((editor: Parameters<DiffOnMount>[0], fileIndex: number) => {
    const file = diff.files[fileIndex];
    if (!file) return;

    // --- Auto-height: resize container to fit content ---
    const containerEl = editorContainerRefs.current.get(fileIndex);
    const updateHeight = () => {
      if (!containerEl) return;
      const contentHeight = editor.getModifiedEditor().getContentHeight();
      const clampedHeight = Math.min(Math.max(contentHeight, 80), 800);
      containerEl.style.height = `${clampedHeight}px`;
      editor.layout();
    };
    editor.getModifiedEditor().onDidContentSizeChange(updateHeight);
    // Initial measurement after hideUnchangedRegions collapses sections
    requestAnimationFrame(() => setTimeout(updateHeight, 100));

    // --- Dispose interceptor (prevents Monaco teardown race) ---
    // We pass keepCurrentOriginalModel + keepCurrentModifiedModel to the
    // DiffEditor so @monaco-editor/react won't dispose models before calling
    // editor.dispose(). Instead we detach models first, then dispose them.
    const originalDispose = editor.dispose.bind(editor);
    editor.dispose = () => {
      const model = editor.getModel();
      editor.setModel(null);
      model?.original?.dispose();
      model?.modified?.dispose();
      originalDispose();
    };

    // --- Comment widgets ---
    managersRef.current.get(file.path)?.dispose();
    const manager = createCommentWidgetManager(editor, {
      filePath: file.path,
      onAddComment: (line, text) => addLineComment(sessionId, file.path, line, text),
      onEditComment: (id, text) => editComment(sessionId, id, text),
      onDeleteComment: (id) => deleteComment(sessionId, id),
      side: "modified",
    });
    manager.setComments(
      visibleComments.filter((c) => c.filePath === file.path),
    );
    managersRef.current.set(file.path, manager);
  }, [diff.files, sessionId, addLineComment, editComment, deleteComment, visibleComments]);

  const handleSendComments = useCallback(() => {
    if (commentCount === 0 || !onSendComments) return;
    const fileContents = new Map<string, string>();
    for (const file of diff.files) {
      fileContents.set(file.path, file.newContent);
    }

    let prompt = "I have the following comments on the code:\n\n";
    const byFile = new Map<string, typeof allComments>();
    for (const c of allComments) {
      if (!byFile.has(c.filePath)) byFile.set(c.filePath, []);
      byFile.get(c.filePath)!.push(c);
    }

    for (const [filePath, fileComments] of byFile) {
      const lines = (fileContents.get(filePath) ?? "").split("\n");
      const lineComments = fileComments.filter((c) => c.kind === "line").sort((a, b) =>
        a.kind === "line" && b.kind === "line" ? a.line - b.line : 0,
      );

      for (const comment of lineComments) {
        if (comment.kind !== "line") continue;
        const start = Math.max(0, comment.line - 3);
        const end = Math.min(lines.length, comment.line + 2);
        const snippet = lines.slice(start, end)
          .map((l, i) => {
            const lineNum = start + i + 1;
            const marker = lineNum === comment.line ? "\u2192" : " ";
            return `${marker} ${lineNum} \u2502 ${l}`;
          })
          .join("\n");
        prompt += `**${filePath}:${comment.line}**\n\`\`\`\n${snippet}\n\`\`\`\nComment: ${comment.text}\n\n`;
      }
    }
    prompt += "Please address each comment.";

    const filePaths = Array.from(byFile.keys());
    onSendComments({ prompt, filePaths, commentCount });
    clearComments(sessionId);
  }, [commentCount, onSendComments, allComments, diff.files, clearComments, sessionId]);

  if (diff.files.length === 0) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between px-4 py-2 border-b border-(--color-border-secondary) bg-(--color-bg-elevated)">
          <span className="text-sm text-(--color-text-secondary)">No changes</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="text-(--color-text-tertiary)"
            aria-label="Close diff panel"
          >
            <XIcon size={ICON_SIZE.SM} />
          </Button>
        </div>
        <div className="flex-1 flex items-center justify-center text-(--color-text-secondary) text-sm">
          No file changes in this turn.
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-(--color-bg-primary)">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-(--color-border-secondary) bg-(--color-bg-elevated) shrink-0 gap-2">
        <div className="flex items-center gap-2 text-sm min-w-0">
          {isMobile && mobileView === "detail" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setMobileView("list")}
              className="text-(--color-text-secondary) p-0.5 shrink-0 flex items-center gap-0.5"
              aria-label="Back to file list"
            >
              <CaretLeftIcon size={ICON_SIZE.SM} />
              <span className="text-xs">Files</span>
            </Button>
          )}
          <span className="text-(--color-text-primary) font-medium shrink-0">{commitMessage ?? "Changes"}</span>
          <span className="text-(--color-success) shrink-0">+{diff.stats.totalInsertions}</span>
          <span className="text-(--color-error) shrink-0">-{diff.stats.totalDeletions}</span>
          <span className="text-(--color-text-secondary) shrink-0">({diff.stats.filesChanged} file{diff.stats.filesChanged !== 1 ? "s" : ""})</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          className="text-(--color-text-tertiary) p-0.5"
          aria-label="Close diff panel"
        >
          <XIcon size={ICON_SIZE.SM} />
        </Button>
      </div>

      {/* Main area: file tree sidebar + stacked diffs.
          - Desktop: both visible side-by-side.
          - Mobile list view: only the sidebar, full width.
          - Mobile detail view: only the selected file's diff, full width. */}
      <div className="flex flex-1 min-h-0">
        {/* File tree sidebar */}
        {(!isMobile || mobileView === "list") && (
          <div className={`${isMobile ? "flex-1" : "w-56 shrink-0 border-r border-(--color-border-primary)"} overflow-y-auto bg-(--color-bg-secondary) py-1`}>
            {fileTree.map((node, i) => (
              <DiffTreeNode
                key={node.path ?? `${node.name}-${i}`}
                node={node}
                depth={0}
                selectedFileIndex={selectedFileIndex}
                onSelect={handleSelectFile}
                expandedDirs={expandedDirs}
                onToggleDir={toggleDir}
              />
            ))}
          </div>
        )}

        {/* Files diff area. Desktop stacks all files; mobile detail shows
            only the selected one. */}
        {(!isMobile || mobileView === "detail") && (
        <div className="flex-1 min-w-0 overflow-y-auto">
          {diff.files.map((file, i) => {
            if (isMobile && i !== selectedFileIndex) return null;
            const collapsed = !isMobile && collapsedFiles.has(i);
            return (
              <div
                key={file.path}
                ref={(el) => {
                  if (el) fileSectionRefs.current.set(i, el);
                  else fileSectionRefs.current.delete(i);
                }}
              >
                {/* File section header */}
                <div
                  className="flex items-center gap-2 px-3 py-1.5 bg-(--color-bg-secondary) cursor-pointer hover:bg-(--color-bg-hover) sticky top-0 z-10 border-y border-(--color-border-primary)"
                  onClick={() => { setSelectedFileIndex(i); if (!isMobile) toggleFileCollapse(i); }}
                >
                  {!isMobile && (collapsed
                    ? <CaretRightIcon size={ICON_SIZE.SM} className="shrink-0 text-(--color-text-tertiary)" />
                    : <CaretDownIcon size={ICON_SIZE.SM} className="shrink-0 text-(--color-text-tertiary)" />
                  )}
                  <span className="text-xs text-(--color-text-primary) truncate">
                    {file.oldPath ? `${file.oldPath} \u2192 ${file.path}` : file.path}
                  </span>
                  <span className="ml-auto shrink-0 flex gap-1.5 text-xs font-mono">
                    {file.insertions > 0 && <span className="text-(--color-success)">+{file.insertions}</span>}
                    {file.deletions > 0 && <span className="text-(--color-error)">-{file.deletions}</span>}
                  </span>
                </div>

                {/* Diff editor (collapsible) */}
                {!collapsed && (
                  file.binary ? (
                    <div className="flex items-center justify-center py-8 text-(--color-text-secondary) text-sm">
                      Binary file — cannot display diff
                    </div>
                  ) : (
                    <div
                      ref={(el) => {
                        if (el) editorContainerRefs.current.set(i, el);
                        else editorContainerRefs.current.delete(i);
                      }}
                      style={{ height: "200px" }}
                    >
                      <DiffEditor
                        key={file.path}
                        original={file.oldContent}
                        modified={file.newContent}
                        language={getLanguageFromPath(file.path)}
                        theme="vs-dark"
                        onMount={(editor) => handleEditorMount(editor, i)}
                        options={DIFF_EDITOR_OPTIONS}
                        keepCurrentOriginalModel
                        keepCurrentModifiedModel
                      />
                    </div>
                  )
                )}
              </div>
            );
          })}
        </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-t border-(--color-border-secondary) bg-(--color-bg-elevated) shrink-0">
        <Button
          variant="secondary"
          size="sm"
          onClick={onClose}
        >
          Close
        </Button>
        {onSendComments && commentCount > 0 && (
          <Button variant="primary" size="sm" onClick={handleSendComments}>
            <PaperPlaneTiltIcon size={ICON_SIZE.SM} className="mr-1" />
            Send {commentCount} comment{commentCount !== 1 ? "s" : ""}
          </Button>
        )}
        <span className="ml-auto text-[10px] text-(--color-text-tertiary) font-mono">
          {diff.fromCommit.slice(0, 7)}..{diff.toCommit.slice(0, 7)}
        </span>
      </div>
    </div>
  );
}
