import { useMemo, useRef, useState } from "react";
import {
  ArrowSquareOutIcon,
  CaretDownIcon,
  CaretRightIcon,
  MagnifyingGlassIcon,
  XIcon,
} from "@phosphor-icons/react";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { ICON_SIZE } from "../design-tokens.js";
import type { DocEntry } from "../../server/shared/types.js";
import { compareDocsByRecency } from "../../server/shared/doc-sort.js";
import { hasTrackedPlanSibling, hasTrackedSibling, isTracked } from "../utils/doc-paths.js";
import { parseIssueRef } from "../utils/issue-ref.js";

export interface DocsViewerProps {
  files: DocEntry[];
  onFileClick: (path: string) => void;
  onRefresh: () => void;
}

/**
 * Shared sizing for every badge in a doc row. A fixed height keeps the cluster
 * aligned regardless of which badges render — notably the progress pill carries
 * a border (+2px box height) that the borderless badges don't, so without a
 * common height it would sit taller than its neighbors.
 */
const DOC_BADGE_CLASS = "h-[18px] text-[11px]";

/** A checklist is "complete" when it has items and all of them are checked. */
function isChecklistComplete(doc: DocEntry): boolean {
  return (
    doc.checklist !== undefined &&
    doc.checklist.total > 0 &&
    doc.checklist.done === doc.checklist.total
  );
}

/**
 * Renders `done/total` from a sibling `checklist.md`. Uses the `success`
 * variant once everything is checked so a fully-complete plan stands out at a
 * glance — the checklist is now the docs list's grouping key (docs/168).
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
 * Jump-to-issue chip for a doc's `issue:` pointer (docs/168). Priority and
 * work-status now live in the tracker, so the docs list links out to it rather
 * than rendering a status badge. The chip stops row-click propagation so
 * clicking it opens the tracker instead of the doc modal.
 */
function IssueChip({ issue }: { issue: string }) {
  const ref = parseIssueRef(issue);
  if (!ref.url) {
    return (
      <Badge variant="default" className={DOC_BADGE_CLASS}>
        {ref.identifier}
      </Badge>
    );
  }
  return (
    <a
      href={ref.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={`Open ${ref.identifier} in ${ref.tracker === "unknown" ? "the tracker" : ref.tracker}`}
      className="inline-flex"
    >
      <Badge
        variant="info"
        className={`${DOC_BADGE_CLASS} inline-flex items-center gap-1 hover:brightness-110`}
      >
        {ref.identifier}
        <ArrowSquareOutIcon size={ICON_SIZE.XS} />
      </Badge>
    </a>
  );
}

/**
 * The trailing badge cluster for a doc row: checklist progress (when present)
 * and a jump-to-issue chip (when the doc carries an `issue:` pointer).
 * `compact` (the collapsed Done group) drops the issue chip to keep those
 * rows quiet.
 */
function DocBadges({
  doc,
  compact = false,
}: {
  doc: DocEntry;
  compact?: boolean;
}) {
  const checklist =
    doc.checklist && doc.checklist.total > 0 ? doc.checklist : null;
  return (
    <>
      {checklist && <ChecklistProgressBadge progress={checklist} />}
      {!compact && doc.issue && <IssueChip issue={doc.issue} />}
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

/**
 * Sort tracked docs newest-first. docs/168 removed priority/status from docs,
 * so there's no longer a "what's hot" signal to sort on — priority lives in the
 * tracker now. Creation-recency is the best ordering left, and the `NNN-`
 * prefix on feature directories is a reliable proxy for it, so we order
 * descending by that number (see `compareDocsByRecency`) to keep the newest
 * work at the top without scrolling.
 */
function sortTrackedDocs(docs: DocEntry[]): DocEntry[] {
  return [...docs].sort((a, b) => compareDocsByRecency(a.path, b.path));
}

/**
 * Returns true when a doc was actually changed in the current session.
 * Derived server-side from git (committed branch changes + uncommitted edits),
 * which is reliable; the old mtime-vs-session-start heuristic produced false
 * positives because git rewrites file mtimes on every checkout/fetch/reset.
 */
function wasModifiedInSession(doc: DocEntry): boolean {
  return doc.changedInSession === true;
}

type Tab = "tracked" | "other";

export function DocsViewer({ files: allFiles, onFileClick, onRefresh }: DocsViewerProps) {
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
          wasModifiedInSession(f) &&
          !hasTrackedPlanSibling(f.path, files) &&
          (isTracked(f, files) || !hasTrackedSibling(f.path, files)),
      ),
    [files],
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
    (f) => isTracked(f, files) && !hasTrackedPlanSibling(f.path, files),
  );
  // Hide untracked siblings (e.g. `checklist.md`) when a tracked plan exists
  // in the same directory — they're now reachable via the modal's sibling
  // tabs, so listing them separately is redundant noise. We check against the
  // full `files` list so a tracked plan that was pulled into the "Modified"
  // group above still suppresses its untracked sibling here.
  const untracked = remaining.filter(
    (f) =>
      !isTracked(f, files) &&
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

  // Done docs (checklist 100% complete) in the Tracked group are collapsed by
  // default — they're historical context, not active work, and would otherwise
  // dominate the list as a project ages.
  const [doneExpanded, setDoneExpanded] = useState(false);

  if (allFiles.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-(--color-text-secondary) text-sm">
        <div className="text-center space-y-2">
          <p className="text-lg font-medium text-(--color-text-tertiary)">No docs found</p>
          <p className="text-xs text-(--color-text-tertiary) max-w-xs">
            Add markdown files to your workspace. Files with an <code className="text-xs bg-(--color-bg-secondary) px-1 rounded">issue:</code> frontmatter
            pointer link out to the tracker; a sibling <code className="text-xs bg-(--color-bg-secondary) px-1 rounded">checklist.md</code> shows progress.
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
  const sortedTracked = sortTrackedDocs(tracked);
  // Split tracked into active work and done (checklist 100% complete) so we can
  // render done items inside a collapsible group below the active list. A doc
  // with no checklist (or an incomplete one) stays Active — see docs/168 for
  // the known edge case where a finished reference doc with no checklist never
  // folds into Done.
  const trackedActive = sortedTracked.filter((d) => !isChecklistComplete(d));
  const trackedDone = sortedTracked.filter((d) => isChecklistComplete(d));
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
                    <DocBadges doc={doc} />
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
                    <DocBadges doc={doc} />
                  </div>
                </div>
              );
            })}
            {trackedDone.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={() => setDoneExpanded((v) => !v)}
                  aria-expanded={doneExpanded}
                  className="flex items-center gap-1.5 w-full text-left px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-(--color-text-tertiary) hover:text-(--color-text-secondary) cursor-pointer"
                >
                  {doneExpanded
                    ? <CaretDownIcon size={ICON_SIZE.XS} />
                    : <CaretRightIcon size={ICON_SIZE.XS} />}
                  <span>Done ({trackedDone.length})</span>
                </button>
                {doneExpanded && trackedDone.map((doc) => {
                  return (
                    <div
                      key={doc.path}
                      className="flex items-center justify-between w-full text-left px-3 py-2 hover:bg-(--color-bg-hover) transition-colors gap-2 group/row"
                    >
                      <DocRowText doc={doc} onClick={() => onFileClick(doc.path)} />
                      <div className="flex items-center gap-2 shrink-0">
                        <DocBadges doc={doc} compact />
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
