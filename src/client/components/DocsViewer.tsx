import { useState, useEffect, useMemo } from "react";
import { marked } from "marked";

export interface DocsViewerProps {
  files: string[];
  selectedFile: string | null;
  content: string | null;
  onSelectFile: (path: string) => void;
  onRefresh: () => void;
}

export function DocsViewer({ files, selectedFile, content, onSelectFile, onRefresh }: DocsViewerProps) {
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);

  // Auto-select the first file when the list loads and nothing is selected
  useEffect(() => {
    if (files.length > 0 && !selectedFile) {
      onSelectFile(files[0]);
    }
  }, [files, selectedFile, onSelectFile]);

  const renderedHtml = useMemo(() => {
    if (!content) return "";
    return marked.parse(content, { async: false }) as string;
  }, [content]);

  if (files.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-(--color-text-secondary) text-sm">
        <div className="text-center space-y-2">
          <div className="text-2xl">&#128196;</div>
          <p>No markdown files found in /workspace.</p>
          <p className="text-xs text-(--color-text-tertiary)">
            Ask the agent to create a README.md or other docs to get started.
          </p>
          <button
            onClick={onRefresh}
            className="mt-2 px-3 py-1 text-xs rounded bg-(--color-bg-secondary) hover:bg-(--color-bg-hover) text-(--color-text-primary) transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* File selector bar */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-(--color-bg-secondary) border-b border-(--color-border-secondary) text-xs text-(--color-text-secondary)">
        <div className="relative flex-1 min-w-0">
          <button
            onClick={() => setIsDropdownOpen(!isDropdownOpen)}
            className="flex items-center gap-1.5 px-2 py-0.5 rounded hover:bg-(--color-bg-hover) transition-colors max-w-full"
          >
            <span className="truncate">{selectedFile || "Select a file..."}</span>
            <span className="shrink-0">{isDropdownOpen ? "\u25B2" : "\u25BC"}</span>
          </button>
          {isDropdownOpen && (
            <div className="absolute top-full left-0 mt-1 w-64 max-h-60 overflow-y-auto bg-(--color-bg-secondary) border border-(--color-border-secondary) rounded shadow-lg z-10">
              {files.map((file) => (
                <button
                  key={file}
                  onClick={() => {
                    onSelectFile(file);
                    setIsDropdownOpen(false);
                  }}
                  className={`block w-full text-left px-3 py-1.5 hover:bg-(--color-bg-hover) transition-colors truncate ${
                    file === selectedFile ? "bg-(--color-bg-tertiary) text-(--color-text-primary)" : "text-(--color-text-secondary)"
                  }`}
                >
                  {file}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          onClick={onRefresh}
          className="px-2 py-0.5 rounded hover:bg-(--color-bg-hover) transition-colors shrink-0 ml-2"
          title="Refresh file list"
        >
          Reload
        </button>
      </div>

      {/* Markdown content */}
      <div className="flex-1 overflow-y-auto p-4">
        {content === null ? (
          <div className="flex items-center justify-center h-full text-(--color-text-secondary) text-sm">
            Loading...
          </div>
        ) : (
          <div
            className="prose dark:prose-invert prose-sm max-w-none"
            dangerouslySetInnerHTML={{ __html: renderedHtml }}
          />
        )}
      </div>
    </div>
  );
}
