import { Badge } from "./ui/badge.js";
import type { BadgeProps } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import type { DocEntry, DocStatus } from "../../server/shared/types.js";

export interface DocsViewerProps {
  files: DocEntry[];
  onFileClick: (path: string) => void;
  onRefresh: () => void;
}

const STATUS_CONFIG: Record<DocStatus, { label: string; variant: BadgeProps["variant"] }> = {
  "planned": { label: "Planned", variant: "default" },
  "in-progress": { label: "In Progress", variant: "warning" },
  "done": { label: "Done", variant: "success" },
  "paused": { label: "Paused", variant: "default" },
};

function StatusBadge({ status }: { status: DocStatus }) {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.planned;
  return (
    <Badge variant={config.variant} className="text-[11px]">
      {config.label}
    </Badge>
  );
}

export function DocsViewer({ files, onFileClick, onRefresh }: DocsViewerProps) {
  if (files.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-(--color-text-secondary) text-sm">
        <div className="text-center space-y-2">
          <p className="text-lg font-medium text-(--color-text-tertiary)">No docs found</p>
          <p className="text-xs text-(--color-text-tertiary) max-w-xs">
            Add markdown files to your workspace. Files with <code className="text-xs bg-(--color-bg-secondary) px-1 rounded">status:</code> frontmatter
            will show status badges.
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

  const tracked = files.filter((f) => f.status !== undefined);
  const untracked = files.filter((f) => f.status === undefined);

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
        {tracked.length > 0 && (
          <div className="py-2">
            <div className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-(--color-text-tertiary)">
              Tracked
            </div>
            {tracked.map((doc) => (
              <button
                key={doc.path}
                onClick={() => onFileClick(doc.path)}
                className="flex items-center w-full text-left px-3 py-2 hover:bg-(--color-bg-hover) transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm text-(--color-text-primary) truncate">
                    {doc.title}
                  </span>
                  {doc.status && <StatusBadge status={doc.status} />}
                </div>
              </button>
            ))}
          </div>
        )}
        {untracked.length > 0 && (
          <div className="py-2">
            {tracked.length > 0 && (
              <div className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-(--color-text-tertiary)">
                Other Docs
              </div>
            )}
            {untracked.map((doc) => (
              <button
                key={doc.path}
                onClick={() => onFileClick(doc.path)}
                className="flex items-center w-full text-left px-3 py-2 hover:bg-(--color-bg-hover) transition-colors text-sm text-(--color-text-secondary) hover:text-(--color-text-primary) cursor-pointer"
              >
                <span className="truncate">{doc.path}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
