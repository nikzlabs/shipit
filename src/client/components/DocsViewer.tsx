import { useMemo, useState } from "react";
import { CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import { Badge } from "./ui/badge.js";
import type { BadgeProps } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { ICON_SIZE } from "../design-tokens.js";
import type { DocEntry, DocPriority, DocStatus } from "../../server/shared/types.js";
import { hasTrackedSibling, isTracked } from "../utils/doc-paths.js";

export interface DocsViewerProps {
  files: DocEntry[];
  onFileClick: (path: string) => void;
  onRefresh: () => void;
  /**
   * ISO timestamp of when the current session was created. When provided, docs
   * whose `modifiedAt` is later than this are pulled into a "Modified in this
   * session" group at the top of the panel.
   */
  sessionStartedAt?: string;
}

const STATUS_CONFIG: Record<DocStatus, { label: string; variant: BadgeProps["variant"]; order: number }> = {
  "in-progress": { label: "In Progress", variant: "warning", order: 0 },
  "planned": { label: "Planned", variant: "info", order: 1 },
  "paused": { label: "Paused", variant: "default", order: 2 },
  "done": { label: "Done", variant: "success", order: 4 },
  "rejected": { label: "Rejected", variant: "error", order: 5 },
};

/** Sort order for docs that carry a `customStatus` (unrecognized status:
 * value). Sits between Paused (2) and Done (4) so author-tagged-but-unknown
 * docs stay visible above completed work. */
const CUSTOM_STATUS_ORDER = 3;

/**
 * Statuses that are "archived" — terminal states the user generally doesn't
 * want cluttering the active work list. We collapse them under a single
 * "Archived" group below the active items. Custom-status docs are NOT
 * archived: an unknown status is by definition "I don't know what this
 * means", so we keep it visible alongside active work.
 */
function isArchivedStatus(status: DocStatus | undefined): boolean {
  return status === "done" || status === "rejected";
}

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

/**
 * Renders the raw, unrecognized `customStatus` value (e.g. "experimental",
 * "blocked") with a neutral badge. The doc is still tracked — see
 * `isTracked()` — but doesn't fall into one of our four typed buckets.
 */
function CustomStatusBadge({ customStatus }: { customStatus: string }) {
  return (
    <Badge variant="default" className="text-[11px]">
      {customStatus}
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

/**
 * Renders `done/total` from a sibling `checklist.md`. Uses the `success`
 * variant once everything is checked so a fully-complete plan stands out
 * even before the author flips `status: done` in frontmatter.
 */
function ChecklistProgressBadge({
  progress,
}: {
  progress: { total: number; done: number };
}) {
  const complete = progress.total > 0 && progress.done === progress.total;
  return (
    <Badge
      variant={complete ? "success" : "default"}
      className="text-[11px] tabular-nums"
      title={`${progress.done} of ${progress.total} checklist items complete`}
    >
      {progress.done}/{progress.total}
    </Badge>
  );
}

/** Show parent directory as secondary context, e.g. "docs/001-feature/" */
function pathContext(docPath: string): string | null {
  const lastSlash = docPath.lastIndexOf("/");
  if (lastSlash <= 0) return null;
  return docPath.slice(0, lastSlash + 1);
}

/**
 * The clickable text column of a doc row: title, an optional frontmatter
 * `description` (wraps to two lines so a full sentence stays readable), and
 * the parent-directory path context as the smallest, last line. Shared across
 * the Modified / Tracked / Archived groups so every row stays consistent.
 */
function DocRowText({ doc, onClick }: { doc: DocEntry; onClick: () => void }) {
  const ctx = pathContext(doc.path);
  return (
    <button onClick={onClick} className="flex-1 min-w-0 text-left cursor-pointer">
      <span className="text-sm text-(--color-text-primary) truncate block">
        {doc.title}
      </span>
      {doc.description && (
        <span className="text-xs text-(--color-text-secondary) line-clamp-2 block">
          {doc.description}
        </span>
      )}
      {ctx && (
        <span className="text-[11px] text-(--color-text-tertiary) truncate block">
          {ctx}
        </span>
      )}
    </button>
  );
}

/** Sort key for a doc's status: known enum order, then custom-status order, then last. */
function statusOrder(doc: DocEntry): number {
  if (doc.status) return STATUS_CONFIG[doc.status]?.order ?? 99;
  if (doc.customStatus) return CUSTOM_STATUS_ORDER;
  return 99;
}

function sortByStatusThenPath(docs: DocEntry[]): DocEntry[] {
  return [...docs].sort((a, b) => {
    const orderA = statusOrder(a);
    const orderB = statusOrder(b);
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

/**
 * Returns true when a doc was modified after the session started.
 * Both timestamps are ISO 8601 strings; lexical comparison works because
 * ISO 8601 strings sort chronologically.
 */
function wasModifiedInSession(doc: DocEntry, sessionStartedAt: string | undefined): boolean {
  if (!sessionStartedAt || !doc.modifiedAt) return false;
  return doc.modifiedAt > sessionStartedAt;
}

type Tab = "tracked" | "other";

export function DocsViewer({ files, onFileClick, onRefresh, sessionStartedAt }: DocsViewerProps) {
  // Docs touched during the current session — shown in a dedicated group at the
  // top so the user sees what the agent just worked on without scrolling.
  // We exclude untracked siblings (e.g. `checklist.md`) when a tracked plan
  // exists in the same directory: they share the derived title and path
  // context, so listing both would render visually identical rows. The user
  // can still reach the checklist via the modal's sibling tabs.
  const modifiedInSession = useMemo(
    () =>
      files.filter(
        (f) =>
          wasModifiedInSession(f, sessionStartedAt) &&
          (isTracked(f) || !hasTrackedSibling(f.path, files)),
      ),
    [files, sessionStartedAt],
  );
  const modifiedPaths = useMemo(
    () => new Set(modifiedInSession.map((f) => f.path)),
    [modifiedInSession],
  );

  // Below the "modified" group, the regular tabs render the rest of the docs.
  // Excluding the session-modified ones avoids duplication — they're already
  // visible at the top.
  const remaining = useMemo(
    () => files.filter((f) => !modifiedPaths.has(f.path)),
    [files, modifiedPaths],
  );

  const tracked = remaining.filter((f) => isTracked(f));
  // Hide untracked siblings (e.g. `checklist.md`) when a tracked plan exists
  // in the same directory — they're now reachable via the modal's sibling
  // tabs, so listing them separately is redundant noise. We check against the
  // full `files` list so a tracked plan that was pulled into the "Modified"
  // group above still suppresses its untracked sibling here.
  const untracked = remaining.filter(
    (f) => !isTracked(f) && !hasTrackedSibling(f.path, files),
  );
  const hasTracked = tracked.length > 0;
  const hasUntracked = untracked.length > 0;
  const hasModified = modifiedInSession.length > 0;

  const [userTab, setUserTab] = useState<Tab | null>(null);
  const activeTab = useMemo<Tab>(() => {
    if (userTab !== null) return userTab;
    return hasTracked ? "tracked" : "other";
  }, [userTab, hasTracked]);

  // Archived docs (done + rejected) in the Tracked group are collapsed by
  // default — they're historical context, not active work, and would otherwise
  // dominate the list as a project ages.
  const [archivedExpanded, setArchivedExpanded] = useState(false);

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

  // Sort the modified-in-session group by recency (most recent first), with
  // path as a deterministic tiebreaker.
  const sortedModified = [...modifiedInSession].sort((a, b) => {
    const am = a.modifiedAt ?? "";
    const bm = b.modifiedAt ?? "";
    if (am !== bm) return am < bm ? 1 : -1;
    return a.path.localeCompare(b.path);
  });
  const sortedTracked = sortByStatusThenPath(tracked);
  // Split tracked into active work and archived (done + rejected) so we can
  // render archived items inside a collapsible group below the active list.
  const trackedActive = sortedTracked.filter((d) => !isArchivedStatus(d.status));
  const trackedArchived = sortedTracked.filter((d) => isArchivedStatus(d.status));
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

      {/* List body — modified-in-session group renders above tabs */}
      <div className="flex-1 overflow-y-auto">
        {hasModified && (
          <div className="py-1 border-b border-(--color-border-secondary)">
            <div className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-(--color-text-tertiary)">
              Modified in this session
            </div>
            {sortedModified.map((doc) => {
              return (
                <div
                  key={doc.path}
                  className="flex items-center justify-between w-full text-left px-3 py-2 hover:bg-(--color-bg-hover) transition-colors gap-2 group/row"
                >
                  <DocRowText doc={doc} onClick={() => onFileClick(doc.path)} />
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant="info" className="text-[11px]">Modified</Badge>
                    {doc.checklist && doc.checklist.total > 0 && (
                      <ChecklistProgressBadge progress={doc.checklist} />
                    )}
                    {doc.status === "planned" && doc.priority && (
                      <PriorityBadge priority={doc.priority} />
                    )}
                    {doc.status && <StatusBadge status={doc.status} />}
                    {!doc.status && doc.customStatus && (
                      <CustomStatusBadge customStatus={doc.customStatus} />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

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

        {(activeTab === "tracked" || !showTabs) && hasTracked && (
          <div className="py-1">
            {!showTabs && (
              <div className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-(--color-text-tertiary)">
                Tracked
              </div>
            )}
            {trackedActive.map((doc) => {
              return (
                <div
                  key={doc.path}
                  className="flex items-center justify-between w-full text-left px-3 py-2 hover:bg-(--color-bg-hover) transition-colors gap-2 group/row"
                >
                  <DocRowText doc={doc} onClick={() => onFileClick(doc.path)} />
                  <div className="flex items-center gap-2 shrink-0">
                    {doc.checklist && doc.checklist.total > 0 && (
                      <ChecklistProgressBadge progress={doc.checklist} />
                    )}
                    {doc.status === "planned" && doc.priority && (
                      <PriorityBadge priority={doc.priority} />
                    )}
                    {doc.status && <StatusBadge status={doc.status} />}
                    {!doc.status && doc.customStatus && (
                      <CustomStatusBadge customStatus={doc.customStatus} />
                    )}
                  </div>
                </div>
              );
            })}
            {trackedArchived.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={() => setArchivedExpanded((v) => !v)}
                  aria-expanded={archivedExpanded}
                  className="flex items-center gap-1.5 w-full text-left px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-(--color-text-tertiary) hover:text-(--color-text-secondary) cursor-pointer"
                >
                  {archivedExpanded
                    ? <CaretDownIcon size={ICON_SIZE.XS} />
                    : <CaretRightIcon size={ICON_SIZE.XS} />}
                  <span>Archived ({trackedArchived.length})</span>
                </button>
                {archivedExpanded && trackedArchived.map((doc) => {
                  return (
                    <div
                      key={doc.path}
                      className="flex items-center justify-between w-full text-left px-3 py-2 hover:bg-(--color-bg-hover) transition-colors gap-2 group/row"
                    >
                      <DocRowText doc={doc} onClick={() => onFileClick(doc.path)} />
                      <div className="flex items-center gap-2 shrink-0">
                        {doc.checklist && doc.checklist.total > 0 && (
                          <ChecklistProgressBadge progress={doc.checklist} />
                        )}
                        {doc.status && <StatusBadge status={doc.status} />}
                      </div>
                    </div>
                  );
                })}
              </>
            )}
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
