import { useState, useCallback, useMemo } from "react";
import { DiffEditor } from "@monaco-editor/react";
import type { FileDiff } from "../../server/types.js";

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
  // Handle dotfiles like "Dockerfile" or ".gitignore"
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
    case "added": return "text-green-400";
    case "modified": return "text-yellow-400";
    case "deleted": return "text-red-400";
    case "renamed": return "text-blue-400";
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
  onAcceptAll: () => void;
  onRejectFiles: (files: string[]) => void;
  onClose: () => void;
  readOnly?: boolean;
  commitMessage?: string;
}

export function DiffPanel({ diff, onAcceptAll, onRejectFiles, onClose, readOnly, commitMessage }: DiffPanelProps) {
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const [checkedFiles, setCheckedFiles] = useState<Set<string>>(new Set());

  const selectedFile = diff.files[selectedFileIndex] ?? null;

  const toggleFile = useCallback((path: string) => {
    setCheckedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const handleRejectSelected = useCallback(() => {
    if (checkedFiles.size > 0) {
      onRejectFiles(Array.from(checkedFiles));
    }
  }, [checkedFiles, onRejectFiles]);

  const language = useMemo(() => {
    return selectedFile ? getLanguageFromPath(selectedFile.path) : "plaintext";
  }, [selectedFile]);

  if (diff.files.length === 0) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between px-4 py-2 border-b border-gray-700 bg-gray-900">
          <span className="text-sm text-gray-400">No changes</span>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300 transition-colors"
            aria-label="Close diff panel"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">
          No file changes in this turn.
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-gray-950">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-700 bg-gray-900 shrink-0">
        <div className="flex items-center gap-2 text-sm min-w-0">
          <span className="text-gray-300 font-medium shrink-0">{readOnly && commitMessage ? commitMessage : "Changes"}</span>
          <span className="text-green-400 shrink-0">+{diff.stats.totalInsertions}</span>
          <span className="text-red-400 shrink-0">-{diff.stats.totalDeletions}</span>
          <span className="text-gray-500 shrink-0">({diff.stats.filesChanged} file{diff.stats.filesChanged !== 1 ? "s" : ""})</span>
        </div>
        <button
          onClick={onClose}
          className="text-gray-500 hover:text-gray-300 transition-colors p-0.5"
          aria-label="Close diff panel"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Main area: file list + diff */}
      <div className="flex flex-1 min-h-0">
        {/* File list sidebar */}
        <div className="w-56 shrink-0 border-r border-gray-800 overflow-y-auto bg-gray-900/50">
          {diff.files.map((file, idx) => (
            <div
              key={file.path}
              className={`flex items-center gap-1.5 px-2 py-1 text-xs cursor-pointer transition-colors ${
                idx === selectedFileIndex
                  ? "bg-blue-900/40 text-gray-100"
                  : "text-gray-400 hover:bg-gray-800/50 hover:text-gray-200"
              }`}
              onClick={() => setSelectedFileIndex(idx)}
            >
              {!readOnly && (
                <input
                  type="checkbox"
                  checked={checkedFiles.has(file.path)}
                  onChange={(e) => {
                    e.stopPropagation();
                    toggleFile(file.path);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="shrink-0 rounded border-gray-600 bg-gray-800 text-blue-500 focus:ring-0 focus:ring-offset-0 w-3 h-3"
                />
              )}
              <span className={`shrink-0 font-mono text-[10px] font-bold ${statusColor(file.status)}`}>
                {statusIcon(file.status)}
              </span>
              <span className="truncate" title={file.path}>
                {file.path.split("/").pop()}
              </span>
              <span className="ml-auto shrink-0 flex gap-1 text-[10px]">
                {file.insertions > 0 && <span className="text-green-400">+{file.insertions}</span>}
                {file.deletions > 0 && <span className="text-red-400">-{file.deletions}</span>}
              </span>
            </div>
          ))}
        </div>

        {/* Diff view */}
        <div className="flex-1 min-w-0">
          {selectedFile ? (
            selectedFile.binary ? (
              <div className="flex items-center justify-center h-full text-gray-500 text-sm">
                Binary file — cannot display diff
              </div>
            ) : (
              <div className="h-full">
                <div className="px-3 py-1 text-xs text-gray-500 border-b border-gray-800 bg-gray-900/30 truncate">
                  {selectedFile.oldPath ? `${selectedFile.oldPath} → ${selectedFile.path}` : selectedFile.path}
                </div>
                <div className="h-[calc(100%-1.75rem)]">
                  <DiffEditor
                    original={selectedFile.oldContent}
                    modified={selectedFile.newContent}
                    language={language}
                    theme="vs-dark"
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
            <div className="flex items-center justify-center h-full text-gray-500 text-sm">
              Select a file to view its diff
            </div>
          )}
        </div>
      </div>

      {/* Action bar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-t border-gray-700 bg-gray-900 shrink-0">
        {readOnly ? (
          <button
            onClick={onClose}
            className="px-3 py-1 text-xs font-medium rounded bg-gray-700 hover:bg-gray-600 text-white transition-colors"
          >
            Close
          </button>
        ) : (
          <>
            <button
              onClick={onAcceptAll}
              className="px-3 py-1 text-xs font-medium rounded bg-green-700 hover:bg-green-600 text-white transition-colors"
            >
              Accept All
            </button>
            {checkedFiles.size > 0 && (
              <button
                onClick={handleRejectSelected}
                className="px-3 py-1 text-xs font-medium rounded bg-red-700 hover:bg-red-600 text-white transition-colors"
              >
                Reject Selected ({checkedFiles.size})
              </button>
            )}
          </>
        )}
        <span className="ml-auto text-[10px] text-gray-600 font-mono">
          {diff.fromCommit.slice(0, 7)}..{diff.toCommit.slice(0, 7)}
        </span>
      </div>
    </div>
  );
}
