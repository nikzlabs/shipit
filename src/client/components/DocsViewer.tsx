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
import { buildDocIndex, hasTrackedPlanSiblingIn, hasTrackedSiblingIn, isTrackedIn } from "../utils/doc-paths.js";
import { parseIssueRef } from "../../server/shared/issue-ref.js";
import { resolveUiIssueRef } from "../stores/issues-store.js";
import type { TrackerId } from "../../server/shared/types.js";

export type OpenDocIssue = (ref: {
  tracker: TrackerId;
  id?: string;
  identifier: string;
  title?: string;
  url?: string;
}) => void;

export interface DocsViewerProps {
  files: DocEntry[];
  onFileClick: (path: string) => void;
  onRefresh: () => void;
  onOpenIssue?: OpenDocIssue;
}

const DOC_BADGE_CLASS = "h-[18px] text-[11px]";

function isChecklistComplete(doc: DocEntry): boolean {
  return (
    doc.checklist !== undefined &&
    doc.checklist.total > 0 &&
    doc.checklist.done === doc.checklist.total
  );
}

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

function IssueChip({ issue, onOpenIssue }: { issue: string; onOpenIssue?: OpenDocIssue }) {
  const resolution = resolveUiIssueRef(issue);
  const ref = resolution.ok ? resolution.ref : parseIssueRef(issue);

  if (onOpenIssue && resolution.ok) {
    const resolved = resolution.ref;
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onOpenIssue({
            tracker: resolved.tracker,
            identifier: resolved.identifier,
            id: resolved.issueId,
            ...(resolved.url ? { url: resolved.url } : {}),
          });
        }}
        title={`Open ${resolved.identifier} in ShipIt`}
        className="inline-flex cursor-pointer"
      >
        <Badge
          variant="info"
          className={`${DOC_BADGE_CLASS} hover:brightness-110`}
        >
          {ref.identifier}
        </Badge>
      </button>
    );
  }

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
      title={`Open ${ref.identifier} in the tracker`}
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

function DocBadges({
  doc,
  compact = false,
  onOpenIssue,
}: {
  doc: DocEntry;
  compact?: boolean;
  onOpenIssue?: OpenDocIssue;
}) {
  const checklist =
    doc.checklist && doc.checklist.total > 0 ? doc.checklist : null;
  return (
    <>
      {checklist && <ChecklistProgressBadge progress={checklist} />}
      {!compact && doc.issue && <IssueChip issue={doc.issue} onOpenIssue={onOpenIssue} />}
    </>
  );
}

function pathContext(docPath: string): string | null {
  const lastSlash = docPath.lastIndexOf("/");
  if (lastSlash <= 0) return null;
  return docPath.slice(0, lastSlash + 1);
}

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

function sortTrackedDocs(docs: DocEntry[]): DocEntry[] {
  return [...docs].sort((a, b) => compareDocsByRecency(a.path, b.path));
}

function wasModifiedInSession(doc: DocEntry): boolean {
  return doc.changedInSession === true;
}

type Tab = "tracked" | "other";

export function DocsViewer({ files: allFiles, onFileClick, onRefresh, onOpenIssue }: DocsViewerProps) {
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

  // Build once: repeated sibling scans made each streamed render cost 342–486 ms.
  const index = useMemo(() => buildDocIndex(files), [files]);

  const modifiedInSession = useMemo(
    () =>
      files.filter(
        (f) =>
          wasModifiedInSession(f) &&
          !hasTrackedPlanSiblingIn(index, f.path) &&
          (isTrackedIn(index, f) || !hasTrackedSiblingIn(index, f.path)),
      ),
    [files, index],
  );
  const modifiedPaths = useMemo(
    () => new Set(modifiedInSession.map((f) => f.path)),
    [modifiedInSession],
  );

  const remaining = useMemo(
    () => files.filter((f) => !modifiedPaths.has(f.path)),
    [files, modifiedPaths],
  );

  const tracked = useMemo(
    () =>
      remaining.filter(
        (f) => isTrackedIn(index, f) && !hasTrackedPlanSiblingIn(index, f.path),
      ),
    [remaining, index],
  );
  const untracked = useMemo(
    () =>
      remaining.filter(
        (f) =>
          !isTrackedIn(index, f) &&
          !hasTrackedSiblingIn(index, f.path) &&
          !hasTrackedPlanSiblingIn(index, f.path),
      ),
    [remaining, index],
  );
  const hasTracked = tracked.length > 0;
  const hasUntracked = untracked.length > 0;
  const hasModified = modifiedInSession.length > 0;

  const [userTab, setUserTab] = useState<Tab | null>(null);
  const activeTab = useMemo<Tab>(() => {
    if (userTab !== null) return userTab;
    return hasTracked ? "tracked" : "other";
  }, [userTab, hasTracked]);

  const [doneExpanded, setDoneExpanded] = useState(false);

  if (allFiles.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-(--color-text-secondary) text-sm">
        <div className="text-center space-y-2">
          <p className="text-lg font-medium text-(--color-text-tertiary)">No docs found</p>
          <p className="text-xs text-(--color-text-tertiary) max-w-xs">
            Add markdown files to your workspace. Files with an <code className="text-xs bg-(--color-bg-secondary) px-1 rounded">issue:</code> frontmatter
            pointer open the linked issue inline; a sibling <code className="text-xs bg-(--color-bg-secondary) px-1 rounded">checklist.md</code> shows progress.
          </p>
          <Button
            variant="secondary"
            size="md"
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

  const sortedModified = [...modifiedInSession].sort((a, b) => {
    const am = a.modifiedAt ?? "";
    const bm = b.modifiedAt ?? "";
    if (am !== bm) return am < bm ? 1 : -1;
    return a.path.localeCompare(b.path);
  });
  const sortedTracked = sortTrackedDocs(tracked);
  const trackedActive = sortedTracked.filter((d) => !isChecklistComplete(d));
  const trackedDone = sortedTracked.filter((d) => isChecklistComplete(d));
  const showTabs = hasTracked && hasUntracked;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-1.5 bg-(--color-bg-secondary) border-b border-(--color-border-secondary) text-xs text-(--color-text-secondary)">
        <span className="font-medium">
          {searchQuery.trim()
            ? `${files.length} of ${allFiles.length} doc${allFiles.length !== 1 ? "s" : ""}`
            : `${allFiles.length} doc${allFiles.length !== 1 ? "s" : ""}`}
        </span>
        <div className="flex items-center gap-1 shrink-0 ml-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={openSearch}
            title="Search docs"
            aria-label="Search docs"
          >
            <MagnifyingGlassIcon size={ICON_SIZE.SM} weight="bold" />
          </Button>
          <Button
            variant="ghost"
            size="md"
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
            className="h-7 w-7 p-0"
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
                    <DocBadges doc={doc} onOpenIssue={onOpenIssue} />
                  </div>
                </div>
              );
            })}
          </div>
        )}

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
                    <DocBadges doc={doc} onOpenIssue={onOpenIssue} />
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
