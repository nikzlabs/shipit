import { Button } from "./ui/button.js";

export interface DocsViewerProps {
  files: string[];
  onFileClick: (path: string) => void;
  onRefresh: () => void;
}

export function DocsViewer({ files, onFileClick, onRefresh }: DocsViewerProps) {
  if (files.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-(--color-text-secondary) text-sm">
        <div className="text-center space-y-2">
          <div className="text-2xl">&#128196;</div>
          <p>No markdown files found in /workspace.</p>
          <p className="text-xs text-(--color-text-tertiary)">
            Ask the agent to create a README.md or other docs to get started.
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={onRefresh}
            className="mt-2"
          >
            Refresh
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header bar */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-(--color-bg-secondary) border-b border-(--color-border-secondary) text-xs text-(--color-text-secondary)">
        <span className="font-medium">{files.length} doc{files.length !== 1 ? "s" : ""}</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          className="shrink-0 ml-2"
          title="Refresh file list"
        >
          Reload
        </Button>
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto">
        {files.map((file) => (
          <button
            key={file}
            onClick={() => onFileClick(file)}
            className="flex items-center w-full text-left px-3 py-2 hover:bg-(--color-bg-hover) transition-colors text-sm text-(--color-text-secondary) hover:text-(--color-text-primary) cursor-pointer"
          >
            <span className="truncate">{file}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
