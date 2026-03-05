import { useState, useMemo } from "react";
import { DiffEditor } from "@monaco-editor/react";
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
}

export function DiffPanel({ diff, onClose, commitMessage }: DiffPanelProps) {
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);

  const selectedFile = diff.files[selectedFileIndex] ?? null;

  const language = useMemo(() => {
    return selectedFile ? getLanguageFromPath(selectedFile.path) : "plaintext";
  }, [selectedFile]);

  if (diff.files.length === 0) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between px-4 py-2 border-b border-(--color-border-secondary) bg-(--color-bg-elevated)">
          <span className="text-sm text-(--color-text-secondary)">No changes</span>
          <button
            onClick={onClose}
            className="text-(--color-text-tertiary) hover:text-(--color-text-primary) transition-colors"
            aria-label="Close diff panel"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
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
        <button
          onClick={onClose}
          className="text-(--color-text-tertiary) hover:text-(--color-text-primary) transition-colors p-0.5"
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
            <div className="flex items-center justify-center h-full text-(--color-text-secondary) text-sm">
              Select a file to view its diff
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-t border-(--color-border-secondary) bg-(--color-bg-elevated) shrink-0">
        <button
          onClick={onClose}
          className="px-3 py-1 text-xs font-medium rounded bg-(--color-bg-tertiary) hover:bg-(--color-bg-hover) text-(--color-text-primary) transition-colors"
        >
          Close
        </button>
        <span className="ml-auto text-[10px] text-(--color-text-tertiary) font-mono">
          {diff.fromCommit.slice(0, 7)}..{diff.toCommit.slice(0, 7)}
        </span>
      </div>
    </div>
  );
}
