import { useMemo, useRef, useState } from "react";
import { CaretDownIcon, CaretRightIcon, MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";
import { Badge } from "./ui/badge.js";
import type { BadgeProps } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { ICON_SIZE } from "../design-tokens.js";
import type { DocEntry, DocPriority, DocStatus } from "../../server/shared/types.js";
import { hasTrackedPlanSibling, hasTrackedSibling, isTracked } from "../utils/doc-paths.js";

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

/**
 * Shared sizing for every badge in a doc row. A fixed height keeps the cluster
 * aligned regardless of which badges render — notably the progress pill carries
 * a border (+2px box height) that the borderless badges don't, so without a
 * common height it would sit taller than its neighbors.
 */
const DOC_BADGE_CLASS = "h-[18px] text-[11px]";

function StatusBadge({ status }: { status: DocStatus }) {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.planned;
  return (
    <Badge variant={config.variant} className={DOC_BADGE_CLASS}>
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
    <Badge variant="default" className={DOC_BADGE_CLASS}>
      {customStatus}
    </Badge>
  );
}

function PriorityBadge({ priority }: { priority: DocPriority }) {
  const config = PRIORITY_CONFIG[priority];
  return (
    <Badge variant={config.variant} className={DOC_BADGE_CLASS}>
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
      className={`${DOC_BADGE_CLASS} tabular-nums`}
      title={`${progress.done} of ${progress.total} checklist items complete`}
    >
      {progress.done}/{progress.total}
    </Badge>
  );
}

/**
 * Fuses the "In Progress" status and the `done/total` checklist count into a
 * single pill whose background doubles as a progress bar: the warning-tinted
 * fill spans `done/total` of the pill width, the rest is the neutral track.
 * The partial fill *is* the "in progress" signal, so we drop the separate
 * status label. Text stays neutral (`text-secondary`) because it sits over
 * both the fill and the track and must read on either.
 */
function ProgressStatusBadge({
  progress,
}: {
  progress: { total: number; done: number };
}) {
  const pct =
    progress.total > 0
      ? Math.round((progress.done / progress.total) * 100)
      : 0;
  return (
    <span
      className={`${DOC_BADGE_CLASS} relative inline-flex w-20 shrink-0 items-center justify-center overflow-hidden rounded-full border border-(--color-border-secondary)/50 px-2 font-medium tabular-nums bg-(--color-bg-tertiary) text-(--color-text-secondary)`}
      title={`In progress — ${progress.done} of ${progress.total} checklist items complete`}
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 bg-(--color-warning-subtle)"
        style={{ width: `${pct}%` }}
      />
      <span className="relative">
        {progress.done}/{progress.total}
      </span>
    </span>
  );
}

/**
 * The trailing badge cluster for a doc row. An in-progress doc that has
 * checklist progress collapses its count and status into a single
 * {@link ProgressStatusBadge}; everything else renders the count and status as
 * separate badges. `compact` (archived rows) omits priority and custom-status
 * badges, matching the reduced cluster those rows showed before.
 */
function DocStatusBadges({
  doc,
  compact = false,
}: {
  doc: DocEntry;
  compact?: boolean;
}) {
  const checklist =
    doc.checklist && doc.checklist.total > 0 ? doc.checklist : null;

  if (doc.status === "in-progress" && checklist) {
    return <ProgressStatusBadge progress={checklist} />;
  }

  return (
    <>
      {checklist && <ChecklistProgressBadge progress={checklist} />}
      {!compact && doc.status === "planned" && doc.priority && (
        <PriorityBadge priority={doc.priority} />
      )}
      {doc.status && <StatusBadge status={doc.status} />}
      {!compact && !doc.status && doc.customStatus && (
        <CustomStatusBadge customStatus={doc.customStatus} />
      )}
    </>
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

export function DocsViewer({ files: allFiles, onFileClick, onRefresh, sessionStartedAt }: DocsViewerProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  const files = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return allFiles;
    return allFiles.filter((f) => {
      if (f.title.toLowerCase().includes(q)) return true;
      if (f.path.toLowerCase().includes(q)) return true;
      if (f.description?.toLowerCase().includes(q)) return true;
      return false;
    });
  }, [allFiles, searchQuery]);

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
          !hasTrackedPlanSibling(f.path, files) &&
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

  const tracked = remaining.filter(
    (f) => isTracked(f) && !hasTrackedPlanSibling(f.path, files),
  );
  // Hide untracked siblings (e.g. `checklist.md`) when a tracked plan exists
  // in the same directory — they're now reachable via the modal's sibling
  // tabs, so listing them separately is redundant noise. We check against the
  // full `files` list so a tracked plan that was pulled into the "Modified"
  // group above still suppresses its untracked sibling here.
  const untracked = remaining.filter(
    (f) =>
      !isTracked(f) &&
      !hasTrackedSibling(f.path, files) &&
      !hasTrackedPlanSibling(f.path, files),
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

  if (allFiles.length === 0) {
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

  const openSearch = () => {
    setSearchOpen(true);
    requestAnimationFrame(() => searchInputRef.current?.focus());
  };
  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery("");
  };

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
        <span className="font-medium">
          {searchQuery.trim()
            ? `${files.length} of ${allFiles.length} doc${allFiles.length !== 1 ? "s" : ""}`
            : `${allFiles.length} doc${allFiles.length !== 1 ? "s" : ""}`}
        </span>
        <div className="flex items-center gap-1 shrink-0 ml-2">
          <button
            onClick={openSearch}
            className="p-1 rounded text-(--color-text-tertiary) hover:text-(--color-text-primary) hover:bg-(--color-bg-hover) transition-colors"
            title="Search docs"
            aria-label="Search docs"
          >
            <MagnifyingGlassIcon size={ICON_SIZE.SM} weight="bold" />
          </button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onRefresh}
            title="Refresh file list"
          >
            Reload
          </Button>
        </div>
      </div>

      {searchOpen && (
        <div className="flex items-center gap-2 px-3 py-2 bg-(--color-bg-secondary) border-b border-(--color-border-primary)">
          <input
            ref={searchInputRef}
            autoFocus
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") closeSearch(); }}
            placeholder="Filter docs..."
            className="flex-1 bg-(--color-bg-elevated) border border-(--color-border-secondary) rounded px-3 py-1 text-sm text-(--color-text-primary) placeholder-(--color-text-tertiary) focus:outline-none focus:ring-1 focus:ring-(--color-border-focus)"
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={closeSearch}
            className="p-1"
            title="Close search (Escape)"
          >
            <XIcon size={ICON_SIZE.SM} />
          </Button>
        </div>
      )}

      {searchQuery.trim() && files.length === 0 && (
        <div className="flex items-center justify-center py-6 text-xs text-(--color-text-tertiary)">
          No docs match &ldquo;{searchQuery.trim()}&rdquo;
        </div>
      )}

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
                    <Badge variant="info" className={DOC_BADGE_CLASS}>Modified</Badge>
                    <DocStatusBadges doc={doc} />
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
                    <DocStatusBadges doc={doc} />
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
                        <DocStatusBadges doc={doc} compact />
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
