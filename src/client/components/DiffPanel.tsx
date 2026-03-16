// eslint-disable-next-line no-restricted-imports -- useRef: Monaco editor ref, useEffect: comment sync
import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { DiffEditor } from "@monaco-editor/react";
import type { DiffOnMount } from "@monaco-editor/react";
import { XIcon, PaperPlaneTiltIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import { useCommentStore } from "../stores/comment-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { createCommentWidgetManager } from "./MonacoCommentWidgets.js";
import type { CommentWidgetManager } from "./MonacoCommentWidgets.js";
import type { FileDiff } from "../../server/shared/types.js";

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

function statusIcon(status: FileDiff["status"]): string {
  switch (status) {
    case "added": return "A";
    case "modified": return "M";
    case "deleted": return "D";
    case "renamed": return "R";
  }
}

function statusColor(status: FileDiff["status"]): string {
  switch (status) {
    case "added": return "text-(--color-success)";
    case "modified": return "text-(--color-warning)";
    case "deleted": return "text-(--color-error)";
    case "renamed": return "text-(--color-text-link)";
  }
}

export interface TurnDiffData {
  fromCommit: string;
  toCommit: string;
  files: FileDiff[];
  stats: { totalInsertions: number; totalDeletions: number; filesChanged: number };
}

interface DiffPanelProps {
  diff: TurnDiffData;
  onClose: () => void;
  commitMessage?: string;
  onSendComments?: (prompt: string) => void;
}

export function DiffPanel({ diff, onClose, commitMessage, onSendComments }: DiffPanelProps) {
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const managerRef = useRef<CommentWidgetManager | null>(null);

  const sessionId = useSessionStore((s) => s.sessionId) ?? "";
  const sessionComments = useCommentStore((s) => s.commentsBySession[sessionId]);
  const allComments = sessionComments ?? [];
  const commentCount = allComments.length;
  const addLineComment = useCommentStore((s) => s.addLineComment);
  const editComment = useCommentStore((s) => s.editComment);
  const deleteComment = useCommentStore((s) => s.deleteComment);
  const clearComments = useCommentStore((s) => s.clearComments);

  const selectedFile = diff.files[selectedFileIndex] ?? null;

  const language = useMemo(() => {
    return selectedFile ? getLanguageFromPath(selectedFile.path) : "plaintext";
  }, [selectedFile]);

  const commentsForFile = useMemo(() => {
    if (!selectedFile) return [];
    return allComments.filter((c) => c.filePath === selectedFile.path);
  }, [allComments, selectedFile]);

  // Clean up manager on file change or unmount
  useEffect(() => {
    return () => {
      managerRef.current?.dispose();
      managerRef.current = null;
    };
  }, [selectedFileIndex]);

  // Sync comments to manager
  useEffect(() => {
    managerRef.current?.setComments(commentsForFile);
  }, [commentsForFile]);

  const handleEditorMount: DiffOnMount = useCallback((editor) => {
    managerRef.current?.dispose();
    if (!selectedFile) return;

    managerRef.current = createCommentWidgetManager(editor, {
      filePath: selectedFile.path,
      onAddComment: (line, text) => addLineComment(sessionId, selectedFile.path, line, text),
      onEditComment: (id, text) => editComment(sessionId, id, text),
      onDeleteComment: (id) => deleteComment(sessionId, id),
      side: "modified",
    });
    managerRef.current.setComments(
      useCommentStore.getState().getCommentsForFile(sessionId, selectedFile.path),
    );
  }, [selectedFile, sessionId, addLineComment, editComment, deleteComment]);

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

    onSendComments(prompt);
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
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-(--color-border-secondary) bg-(--color-bg-elevated) shrink-0">
        <div className="flex items-center gap-2 text-sm min-w-0">
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

      {/* Main area: file list + diff */}
      <div className="flex flex-1 min-h-0">
        {/* File list sidebar */}
        <div className="w-56 shrink-0 border-r border-(--color-border-primary) overflow-y-auto bg-(--color-bg-secondary)">
          {diff.files.map((file, idx) => (
            <div
              key={file.path}
              className={`flex items-center gap-1.5 px-2 py-1 text-xs cursor-pointer transition-colors ${
                idx === selectedFileIndex
                  ? "bg-(--color-accent-subtle) text-(--color-text-primary)"
                  : "text-(--color-text-secondary) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)"
              }`}
              onClick={() => setSelectedFileIndex(idx)}
            >
              <span className={`shrink-0 font-mono text-[10px] font-bold ${statusColor(file.status)}`}>
                {statusIcon(file.status)}
              </span>
              <span className="truncate" title={file.path}>
                {file.path.split("/").pop()}
              </span>
              <span className="ml-auto shrink-0 flex gap-1 text-[10px]">
                {file.insertions > 0 && <span className="text-(--color-success)">+{file.insertions}</span>}
                {file.deletions > 0 && <span className="text-(--color-error)">-{file.deletions}</span>}
              </span>
            </div>
          ))}
        </div>

        {/* Diff view */}
        <div className="flex-1 min-w-0">
          {selectedFile ? (
            selectedFile.binary ? (
              <div className="flex items-center justify-center h-full text-(--color-text-secondary) text-sm">
                Binary file — cannot display diff
              </div>
            ) : (
              <div className="h-full">
                <div className="px-3 py-1 text-xs text-(--color-text-secondary) border-b border-(--color-border-primary) bg-(--color-bg-secondary) truncate">
                  {selectedFile.oldPath ? `${selectedFile.oldPath} \u2192 ${selectedFile.path}` : selectedFile.path}
                </div>
                <div className="h-[calc(100%-1.75rem)]">
                  <DiffEditor
                    original={selectedFile.oldContent}
                    modified={selectedFile.newContent}
                    language={language}
                    theme="vs-dark"
                    onMount={handleEditorMount}
                    options={{
                      readOnly: true,
                      renderSideBySide: true,
                      minimap: { enabled: false },
                      scrollBeyondLastLine: false,
                      fontSize: 12,
                      lineNumbers: "on",
                      folding: false,
                      wordWrap: "off",
                      renderOverviewRuler: false,
                      diffWordWrap: "off",
                      glyphMargin: true,
                      scrollbar: {
                        verticalScrollbarSize: 8,
                        horizontalScrollbarSize: 8,
                      },
                    }}
                  />
                </div>
              </div>
            )
          ) : (
            <div className="flex items-center justify-center h-full text-(--color-text-secondary) text-sm">
              Select a file to view its diff
            </div>
          )}
        </div>
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
