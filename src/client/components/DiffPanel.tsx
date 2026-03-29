// eslint-disable-next-line no-restricted-imports -- useRef: Monaco editor ref, useEffect: comment sync
import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { DiffEditor } from "@monaco-editor/react";
import type { DiffOnMount } from "@monaco-editor/react";
import { XIcon, PaperPlaneTiltIcon, CaretRightIcon, CaretDownIcon, FolderIcon, FolderOpenIcon, FileIcon } from "@phosphor-icons/react";
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

/** Tree node for the file tree sidebar. */
interface FileTreeNode {
  name: string;
  /** Full path for leaf (file) nodes. */
  path?: string;
  /** Index into diff.files for leaf nodes. */
  fileIndex?: number;
  /** Child nodes for directory nodes. */
  children?: FileTreeNode[];
  /** Aggregated stats for directories. */
  insertions: number;
  deletions: number;
  /** File status for leaf nodes. */
  status?: FileDiff["status"];
}

/** Build a nested tree from a flat list of FileDiff entries. */
function buildFileTree(files: FileDiff[]): FileTreeNode[] {
  const root: FileTreeNode = { name: "", children: [], insertions: 0, deletions: 0 };

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const parts = file.path.split("/");
    let current = root;

    for (let j = 0; j < parts.length; j++) {
      const part = parts[j];
      const isFile = j === parts.length - 1;

      if (isFile) {
        current.children!.push({
          name: part,
          path: file.path,
          fileIndex: i,
          insertions: file.insertions,
          deletions: file.deletions,
          status: file.status,
        });
      } else {
        let dir = current.children!.find((c) => c.children && c.name === part);
        if (!dir) {
          dir = { name: part, children: [], insertions: 0, deletions: 0 };
          current.children!.push(dir);
        }
        current = dir;
      }
    }
  }

  // Propagate stats up
  function sumStats(node: FileTreeNode): void {
    if (!node.children) return;
    node.insertions = 0;
    node.deletions = 0;
    for (const child of node.children) {
      sumStats(child);
      node.insertions += child.insertions;
      node.deletions += child.deletions;
    }
  }
  sumStats(root);

  // Collapse single-child directories (src/client → src/client)
  function collapse(nodes: FileTreeNode[]): FileTreeNode[] {
    return nodes.map((node) => {
      if (node.children) {
        node.children = collapse(node.children);
        if (node.children.length === 1 && node.children[0].children) {
          const child = node.children[0];
          return { ...child, name: `${node.name}/${child.name}` };
        }
      }
      return node;
    });
  }

  return collapse(root.children!);
}

/** Renders a single node in the diff file tree. */
function DiffTreeNode({
  node,
  depth,
  selectedFileIndex,
  onSelect,
  expandedDirs,
  onToggleDir,
}: {
  node: FileTreeNode;
  depth: number;
  selectedFileIndex: number;
  onSelect: (idx: number) => void;
  expandedDirs: Set<string>;
  onToggleDir: (path: string) => void;
}) {
  const isDir = !!node.children;

  if (isDir) {
    // Build a stable key from the dir name path
    const fullDirKey = `dir:${depth}:${node.name}`;
    const expanded = expandedDirs.has(fullDirKey);

    return (
      <>
        <div
          className="flex items-center gap-1 px-2 py-0.5 text-xs cursor-pointer text-(--color-text-secondary) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
          onClick={() => onToggleDir(fullDirKey)}
        >
          {expanded
            ? <CaretDownIcon size={10} className="shrink-0" />
            : <CaretRightIcon size={10} className="shrink-0" />
          }
          {expanded
            ? <FolderOpenIcon size={ICON_SIZE.XS} className="shrink-0 text-(--color-text-tertiary)" />
            : <FolderIcon size={ICON_SIZE.XS} className="shrink-0 text-(--color-text-tertiary)" />
          }
          <span className="truncate">{node.name}</span>
          <span className="ml-auto shrink-0 flex gap-1 text-[10px]">
            {node.insertions > 0 && <span className="text-(--color-success)">+{node.insertions}</span>}
            {node.deletions > 0 && <span className="text-(--color-error)">-{node.deletions}</span>}
          </span>
        </div>
        {expanded && node.children!.map((child, i) => (
          <DiffTreeNode
            key={child.path ?? `${child.name}-${i}`}
            node={child}
            depth={depth + 1}
            selectedFileIndex={selectedFileIndex}
            onSelect={onSelect}
            expandedDirs={expandedDirs}
            onToggleDir={onToggleDir}
          />
        ))}
      </>
    );
  }

  // File leaf
  const isSelected = node.fileIndex === selectedFileIndex;
  return (
    <div
      className={`flex items-center gap-1.5 px-2 py-0.5 text-xs cursor-pointer transition-colors ${
        isSelected
          ? "bg-(--color-accent-subtle) text-(--color-text-primary)"
          : "text-(--color-text-secondary) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)"
      }`}
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
      onClick={() => onSelect(node.fileIndex!)}
    >
      <span className={`shrink-0 font-mono text-[10px] font-bold ${statusColor(node.status!)}`}>
        {statusIcon(node.status!)}
      </span>
      <FileIcon size={ICON_SIZE.XS} className="shrink-0 text-(--color-text-tertiary)" />
      <span className="truncate" title={node.path}>
        {node.name}
      </span>
      <span className="ml-auto shrink-0 flex gap-1 text-[10px]">
        {node.insertions > 0 && <span className="text-(--color-success)">+{node.insertions}</span>}
        {node.deletions > 0 && <span className="text-(--color-error)">-{node.deletions}</span>}
      </span>
    </div>
  );
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
  const fileSectionRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const editorContainerRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const managersRef = useRef<Map<string, CommentWidgetManager>>(new Map());

  const sessionId = useSessionStore((s) => s.sessionId) ?? "";
  const sessionComments = useCommentStore((s) => s.commentsBySession[sessionId]);
  const allComments = sessionComments ?? [];
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

  /** Sidebar click: highlight, expand if collapsed, scroll into view. */
  const handleSelectFile = useCallback((index: number) => {
    setSelectedFileIndex(index);
    setCollapsedFiles((prev) => {
      if (!prev.has(index)) return prev;
      const next = new Set(prev);
      next.delete(index);
      return next;
    });
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
  useEffect(() => {
    return () => {
      for (const manager of managersRef.current.values()) {
        manager.dispose();
      }
      managersRef.current.clear();
    };
  }, []);

  // Sync comments to all active managers
  useEffect(() => {
    for (const [filePath, manager] of managersRef.current.entries()) {
      manager.setComments(allComments.filter((c) => c.filePath === filePath));
    }
  }, [allComments]);

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
      useCommentStore.getState().getCommentsForFile(sessionId, file.path),
    );
    managersRef.current.set(file.path, manager);
  }, [diff.files, sessionId, addLineComment, editComment, deleteComment]);

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

      {/* Main area: file tree sidebar + stacked diffs */}
      <div className="flex flex-1 min-h-0">
        {/* File tree sidebar */}
        <div className="w-56 shrink-0 border-r border-(--color-border-primary) overflow-y-auto bg-(--color-bg-secondary) py-1">
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

        {/* All files stacked in a single scrollable container */}
        <div className="flex-1 min-w-0 overflow-y-auto">
          {diff.files.map((file, i) => {
            const collapsed = collapsedFiles.has(i);
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
                  onClick={() => { setSelectedFileIndex(i); toggleFileCollapse(i); }}
                >
                  {collapsed
                    ? <CaretRightIcon size={ICON_SIZE.SM} className="shrink-0 text-(--color-text-tertiary)" />
                    : <CaretDownIcon size={ICON_SIZE.SM} className="shrink-0 text-(--color-text-tertiary)" />
                  }
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
