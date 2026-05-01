import { useMemo, useState } from "react";
import { Badge } from "./ui/badge.js";
import type { BadgeProps } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import type { DocEntry, DocPriority, DocStatus } from "../../server/shared/types.js";
import { hasTrackedSibling } from "../utils/doc-paths.js";

export interface DocsViewerProps {
  files: DocEntry[];
  onFileClick: (path: string) => void;
  onRefresh: () => void;
}

const STATUS_CONFIG: Record<DocStatus, { label: string; variant: BadgeProps["variant"]; order: number }> = {
  "in-progress": { label: "In Progress", variant: "warning", order: 0 },
  "planned": { label: "Planned", variant: "info", order: 1 },
  "paused": { label: "Paused", variant: "default", order: 2 },
  "done": { label: "Done", variant: "success", order: 3 },
};

const PRIORITY_CONFIG: Record<DocPriority, { label: string; variant: BadgeProps["variant"]; order: number }> = {
  high: { label: "High", variant: "error", order: 0 },
  medium: { label: "Med", variant: "warning", order: 1 },
  low: { label: "Low", variant: "default", order: 2 },
};

/** Sort key for priority. Unset priorities sort after all set priorities. */
function priorityOrder(priority: DocPriority | undefined): number {
  return priority ? PRIORITY_CONFIG[priority].order : 99;
}

function StatusBadge({ status }: { status: DocStatus }) {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.planned;
  return (
    <Badge variant={config.variant} className="text-[11px]">
      {config.label}
    </Badge>
  );
}

function PriorityBadge({ priority }: { priority: DocPriority }) {
  const config = PRIORITY_CONFIG[priority];
  return (
    <Badge variant={config.variant} className="text-[11px]">
      {config.label}
    </Badge>
  );
}

/** Show parent directory as secondary context, e.g. "docs/001-feature/" */
function pathContext(docPath: string): string | null {
  const lastSlash = docPath.lastIndexOf("/");
  if (lastSlash <= 0) return null;
  return docPath.slice(0, lastSlash + 1);
}

function sortByStatusThenPath(docs: DocEntry[]): DocEntry[] {
  return [...docs].sort((a, b) => {
    const orderA = a.status ? STATUS_CONFIG[a.status]?.order ?? 99 : 99;
    const orderB = b.status ? STATUS_CONFIG[b.status]?.order ?? 99 : 99;
    if (orderA !== orderB) return orderA - orderB;
    // Within the planned bucket, sort by priority (high → medium → low → unset),
    // then by path *descending* so the most recently added planned items
    // (highest NNN- prefix) bubble up within each priority tier.
    if (a.status === "planned" && b.status === "planned") {
      const pA = priorityOrder(a.priority);
      const pB = priorityOrder(b.priority);
      if (pA !== pB) return pA - pB;
      return b.path.localeCompare(a.path);
    }
    return a.path.localeCompare(b.path);
  });
}

type Tab = "tracked" | "other";

export function DocsViewer({ files, onFileClick, onRefresh }: DocsViewerProps) {
  const tracked = files.filter((f) => f.status !== undefined);
  // Hide untracked siblings (e.g. `checklist.md`) when a tracked plan exists
  // in the same directory — they're now reachable via the modal's sibling
  // tabs, so listing them separately is redundant noise.
  const untracked = files.filter(
    (f) => f.status === undefined && !hasTrackedSibling(f.path, files),
  );
  const hasTracked = tracked.length > 0;
  const hasUntracked = untracked.length > 0;

  const [userTab, setUserTab] = useState<Tab | null>(null);
  const activeTab = useMemo<Tab>(() => {
    if (userTab !== null) return userTab;
    return hasTracked ? "tracked" : "other";
  }, [userTab, hasTracked]);

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

  const sortedTracked = sortByStatusThenPath(tracked);
  const showTabs = hasTracked && hasUntracked;

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

      {/* Tabs */}
      {showTabs && (
        <div className="flex border-b border-(--color-border-secondary)">
          <button
            onClick={() => setUserTab("tracked")}
            className={`flex-1 px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer border-b-2 ${
              activeTab === "tracked"
                ? "text-(--color-text-primary) border-(--color-accent)"
                : "text-(--color-text-tertiary) border-transparent hover:text-(--color-text-secondary)"
            }`}
          >
            Tracked ({tracked.length})
          </button>
          <button
            onClick={() => setUserTab("other")}
            className={`flex-1 px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer border-b-2 ${
              activeTab === "other"
                ? "text-(--color-text-primary) border-(--color-accent)"
                : "text-(--color-text-tertiary) border-transparent hover:text-(--color-text-secondary)"
            }`}
          >
            Other ({untracked.length})
          </button>
        </div>
      )}

      {/* File list */}
      <div className="flex-1 overflow-y-auto">
        {(activeTab === "tracked" || !showTabs) && hasTracked && (
          <div className="py-1">
            {!showTabs && (
              <div className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-(--color-text-tertiary)">
                Tracked
              </div>
            )}
            {sortedTracked.map((doc) => {
              const ctx = pathContext(doc.path);
              return (
                <div
                  key={doc.path}
                  className="flex items-center justify-between w-full text-left px-3 py-2 hover:bg-(--color-bg-hover) transition-colors gap-2 group/row"
                >
                  <button
                    onClick={() => onFileClick(doc.path)}
                    className="flex-1 min-w-0 text-left cursor-pointer"
                  >
                    <span className="text-sm text-(--color-text-primary) truncate block">
                      {doc.title}
                    </span>
                    {ctx && (
                      <span className="text-[11px] text-(--color-text-tertiary) truncate block">
                        {ctx}
                      </span>
                    )}
                  </button>
                  <div className="flex items-center gap-2 shrink-0">
                    {doc.status === "planned" && doc.priority && (
                      <PriorityBadge priority={doc.priority} />
                    )}
                    {doc.status && <StatusBadge status={doc.status} />}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {(activeTab === "other" || !showTabs) && hasUntracked && (
          <div className="py-1">
            {!showTabs && (
              <div className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-(--color-text-tertiary)">
                Other Docs
              </div>
            )}
            {[...untracked].sort((a, b) => a.path.localeCompare(b.path)).map((doc) => (
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
