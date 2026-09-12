import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import {
  ArrowClockwiseIcon,
  CaretRightIcon,
  CheckCircleIcon,
  PlugIcon,
  SlidersHorizontalIcon,
  UserIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { Button } from "./ui/button.js";
import { StartSessionButton } from "./StartSessionButton.js";
import { IssuesFilterBar } from "./IssuesFilterBar.js";
import { IssuesSortModal } from "./IssuesSortModal.js";
import { describeSort, isNonDefaultSort, type IssueRowItem, type IssueSection, type SortPrefs } from "./issues-sort.js";
import { useNarrowContainer } from "../hooks/useNarrowContainer.js";
import {
  IssuePriorityEditor,
  IssueStatusEditor,
  PriorityBadge,
  PriorityTrigger,
  statusDotColor,
  type IssueStatusRef,
} from "./IssueFieldControls.js";
import { anyFilterActive, type AssigneeOption, type IssueFilters, type LabelOption, type StatusOption } from "./issues-filter.js";
import { labelDotColor } from "./issue-label-color.js";
import { useSurfaceLuminance } from "../hooks/useSurfaceLuminance.js";
import { adaptColorForSurface } from "../utils/status-color.js";
import { ICON_SIZE } from "../design-tokens.js";
import { isGitHubTracker } from "../../server/shared/tracker-id.js";
import type {
  IssueLabel,
  IssuePriorityLevel,
  RepoInfo,
  TrackerId,
  TrackerInfo,
  TrackerIssue,
} from "../../server/shared/types.js";
import { Spinner } from "./Spinner.js";

export interface IssuesViewerProps {
  trackers: TrackerInfo[];
  activeTracker: TrackerId;
  issues: TrackerIssue[];
  filteredIssues: TrackerIssue[];
  desktopSections: IssueSection[];
  mobileSections: IssueSection[];
  sortPrefs: SortPrefs;
  filters: IssueFilters;
  statusOptions: StatusOption[];
  assigneeOptions: AssigneeOption[];
  labelOptions: LabelOption[];
  priorityCounts: Record<IssuePriorityLevel, number>;
  info?: TrackerInfo;
  loading: boolean;
  error: string | null;
  canStart: boolean;
  repos: RepoInfo[];
  targetRepoUrl?: string;
  includeDone: boolean;
  availableStatuses: IssueStatusRef[];
  canEditPriority: boolean;
  onSelectTracker: (id: TrackerId) => void;
  onRefresh: () => void;
  onToggleIncludeDone: () => void;
  onSetSortPrefs: (prefs: SortPrefs) => void;
  onSetCollapsed: (issueId: string, collapsed: boolean) => void;
  onOpenIssue: (issue: TrackerIssue) => void;
  initialScrollTop: number;
  onPersistScroll: (top: number) => void;
  onSetStatus: (issue: TrackerIssue, status: string) => Promise<string | null>;
  onSetPriority: (issue: TrackerIssue, level: IssuePriorityLevel) => Promise<string | null>;
  onStartSession: (issue: TrackerIssue, repoUrl?: string) => void;
  onConnect: () => void;
  onSetQuery: (query: string) => void;
  onTogglePriority: (level: IssuePriorityLevel) => void;
  onToggleStatus: (name: string) => void;
  onToggleAssignee: (value: string) => void;
  onToggleLabel: (name: string) => void;
  onClearFilters: () => void;
}

function shortIdentifier(identifier: string): string {
  const hash = identifier.indexOf("#");
  return hash === -1 ? identifier : identifier.slice(hash + 1);
}

function AssigneeLabel({ assignee }: { assignee: NonNullable<TrackerIssue["assignee"]> }) {
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0">
      {assignee.avatarUrl ? (
        <img
          src={assignee.avatarUrl}
          alt=""
          className="shrink-0 w-5 h-5 rounded-full object-cover ring-1 ring-(--color-border-primary)"
        />
      ) : (
        <span className="shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-full bg-(--color-bg-tertiary) ring-1 ring-(--color-border-primary)">
          <UserIcon size={ICON_SIZE.XS} className="text-(--color-text-tertiary)" />
        </span>
      )}
      <span className="truncate">{assignee.name}</span>
    </span>
  );
}

const MAX_LABELS = 4;

function IssueLabels({ labels }: { labels?: IssueLabel[] }) {
  if (!labels || labels.length === 0) return null;
  const shown = labels.slice(0, MAX_LABELS);
  const overflow = labels.length - shown.length;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1">
      {shown.map((label) => (
        <span
          key={label.name}
          className="inline-flex items-center gap-1 max-w-[160px] rounded-full border border-(--color-border-primary) bg-(--color-bg-secondary) pl-1.5 pr-2 py-px text-[10px] font-medium text-(--color-text-secondary)"
        >
          <span
            className="size-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: label.color ?? labelDotColor(label.name) }}
            aria-hidden="true"
          />
          <span className="truncate">{label.name}</span>
        </span>
      ))}
      {overflow > 0 && (
        <span
          className="text-[10px] font-medium text-(--color-text-tertiary)"
          title={labels.slice(MAX_LABELS).map((l) => l.name).join(", ")}
        >
          +{overflow}
        </span>
      )}
    </div>
  );
}

// The fixed 168px action track keeps the separate header and row grids aligned
// and fits the split repo picker. Recheck it if that control changes.
const ROW_GRID =
  "grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 " +
  "[grid-template-areas:'id_pri'_'title_title'_'meta_meta'_'nested_nested'_'action_action'] " +
  "@md:grid-cols-[56px_minmax(96px,1fr)_84px_96px_92px_168px] @md:gap-x-2.5 @md:items-start " +
  "@md:[grid-template-areas:'id_title_pri_status_assignee_action']";

const FIRST_LINE = "flex items-center h-6";

// Keep collapse behavior synchronized with Tailwind's @md container breakpoint.
const CARD_BREAKPOINT_PX = 448;

const DESKTOP_INDENT_STEP = 14;
const DESKTOP_INDENT_MAX_DEPTH = 8;
const MOBILE_INDENT_STEP = 4;
const MOBILE_INDENT_MAX_DEPTH = 3;

function IssueRow({
  row,
  canStart,
  repos,
  targetRepoUrl,
  availableStatuses,
  canEditPriority,
  surfaceLum,
  onOpenIssue,
  onSetCollapsed,
  onSetStatus,
  onSetPriority,
  onStartSession,
}: {
  row: IssueRowItem;
  canStart: boolean;
  repos: RepoInfo[];
  targetRepoUrl?: string;
  availableStatuses: IssueStatusRef[];
  canEditPriority: boolean;
  surfaceLum: number;
  onOpenIssue: (issue: TrackerIssue) => void;
  onSetCollapsed: (issueId: string, collapsed: boolean) => void;
  onSetStatus: (issue: TrackerIssue, status: string) => Promise<string | null>;
  onSetPriority: (issue: TrackerIssue, level: IssuePriorityLevel) => Promise<string | null>;
  onStartSession: (issue: TrackerIssue, repoUrl?: string) => void;
}) {
  const { issue, depth, hasChildren, childCount, collapsed, orphan } = row;
  const mobileIndent = Math.min(depth, MOBILE_INDENT_MAX_DEPTH) * MOBILE_INDENT_STEP;
  const desktopIndent = Math.min(depth, DESKTOP_INDENT_MAX_DEPTH) * DESKTOP_INDENT_STEP;
  const toggle = () => onSetCollapsed(issue.id, !collapsed);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open ${issue.identifier}: ${issue.title}`}
      onClick={() => onOpenIssue(issue)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpenIssue(issue);
        }
      }}
      style={{ "--mind": `${mobileIndent}px`, "--dind": `${desktopIndent}px` } as CSSProperties}
      className={`${ROW_GRID} group relative py-3 pr-3 pl-[calc(0.75rem+var(--mind,0px))] @md:pl-[calc(0.75rem+var(--dind,0))] cursor-pointer transition-colors focus:outline-none hover:bg-(--color-bg-hover) focus-visible:bg-(--color-bg-hover) before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:rounded-r before:bg-(--color-accent) before:opacity-0 before:transition-opacity group-hover:before:opacity-100 focus-visible:before:opacity-100`}
    >
      <span className={`[grid-area:id] ${FIRST_LINE} text-[11px] font-mono text-(--color-text-tertiary) group-hover:text-(--color-text-secondary) transition-colors min-w-0`}>
        <span className="truncate">{shortIdentifier(issue.identifier)}</span>
      </span>

      <div className="[grid-area:title] min-w-0">
        <div className="flex items-center min-h-6 text-sm font-medium text-(--color-text-primary)">
          {hasChildren && (
            <span className="hidden @md:flex items-center shrink-0 self-start h-6">
              <button
                type="button"
                aria-label={collapsed ? `Expand ${issue.identifier}` : `Collapse ${issue.identifier}`}
                aria-expanded={!collapsed}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle();
                }}
                onKeyDown={(e) => e.stopPropagation()}
                className="mr-1 inline-flex size-4 shrink-0 items-center justify-center rounded text-(--color-text-tertiary) hover:bg-(--color-bg-tertiary) hover:text-(--color-text-primary) cursor-pointer"
              >
                <CaretRightIcon
                  size={ICON_SIZE.XS}
                  weight="bold"
                  className={`transition-transform ${collapsed ? "" : "rotate-90"}`}
                />
              </button>
            </span>
          )}
          <span className="line-clamp-2">{issue.title}</span>
          {hasChildren && (
            <span
              className="hidden @md:inline-flex shrink-0 ml-1.5 items-center rounded-full border border-(--color-border-primary) bg-(--color-bg-secondary) px-1.5 text-[10px] font-semibold leading-[15px] text-(--color-text-tertiary)"
              title={`${childCount} sub-issue${childCount !== 1 ? "s" : ""}`}
            >
              {childCount}
            </span>
          )}
        </div>
        {orphan && issue.parentIdentifier && (
          <div className="text-[10px] text-(--color-text-tertiary) mt-0.5">
            ↳ in <span className="font-mono text-(--color-text-secondary)">{issue.parentIdentifier}</span>
          </div>
        )}
        {issue.description && (
          <div className="text-[11px] text-(--color-text-tertiary) line-clamp-1 mt-0.5">
            {issue.description}
          </div>
        )}
        <IssueLabels labels={issue.labels} />
      </div>

      <div className={`[grid-area:pri] ${FIRST_LINE} justify-self-end @md:justify-self-start`}>
        {canEditPriority ? (
          <IssuePriorityEditor
            current={issue.priority.level}
            onSelect={(level) => onSetPriority(issue, level)}
            ariaLabel={`Change priority of ${issue.identifier} (currently ${issue.priority.label})`}
            trigger={<PriorityTrigger priority={issue.priority} surfaceLum={surfaceLum} />}
            align="end"
          />
        ) : (
          <PriorityBadge priority={issue.priority} surfaceLum={surfaceLum} />
        )}
      </div>

      <div className="hidden @md:flex items-center h-6 [grid-area:status] text-xs text-(--color-text-secondary) min-w-0">
        {issue.status && (
          <IssueStatusEditor
            current={issue.status}
            options={availableStatuses}
            onSelect={(name) => onSetStatus(issue, name)}
            ariaLabel={`Change status of ${issue.identifier} (currently ${issue.status.name})`}
            trigger={
              <span className="inline-flex items-center gap-1.5 min-w-0">
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: adaptColorForSurface(statusDotColor(issue.status), surfaceLum) }}
                  aria-hidden="true"
                />
                <span className="truncate">{issue.status.name}</span>
              </span>
            }
          />
        )}
      </div>

      <div className="hidden @md:flex items-center h-6 [grid-area:assignee] text-xs text-(--color-text-secondary) min-w-0">
        {issue.assignee && <AssigneeLabel assignee={issue.assignee} />}
      </div>

      <div className="@md:hidden [grid-area:meta] flex items-center gap-1.5 text-[11px] text-(--color-text-tertiary) min-w-0">
        {issue.status && (
          <span className="inline-flex items-center gap-1.5 min-w-0">
            <span
              className="size-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: adaptColorForSurface(statusDotColor(issue.status), surfaceLum) }}
              aria-hidden="true"
            />
            <span className="truncate">{issue.status.name}</span>
          </span>
        )}
        {issue.status && issue.assignee && <span aria-hidden="true">·</span>}
        {issue.assignee && <AssigneeLabel assignee={issue.assignee} />}
      </div>

      {hasChildren && (
        <button
          type="button"
          aria-label={
            collapsed
              ? `Show ${childCount} nested issue${childCount !== 1 ? "s" : ""} in ${issue.identifier}`
              : `Hide nested issues in ${issue.identifier}`
          }
          aria-expanded={!collapsed}
          onClick={(e) => {
            e.stopPropagation();
            toggle();
          }}
          onKeyDown={(e) => e.stopPropagation()}
          className="@md:hidden [grid-area:nested] mt-0.5 inline-flex w-fit items-center gap-1 rounded text-[11px] font-medium text-(--color-text-secondary) hover:text-(--color-text-primary) cursor-pointer"
        >
          <CaretRightIcon
            size={ICON_SIZE.XS}
            weight="bold"
            className={`transition-transform ${collapsed ? "" : "rotate-90"}`}
          />
          {childCount} nested issue{childCount !== 1 ? "s" : ""}
        </button>
      )}

      <div className={`[grid-area:action] ${FIRST_LINE} w-full justify-center`}>
        <StartSessionButton
          disabled={!canStart}
          title={canStart ? "Seed a ShipIt session prompt from this issue" : "Add a repo first to start a session"}
          onClick={(e) => {
            e.stopPropagation();
            onStartSession(issue);
          }}
          repos={repos}
          {...(targetRepoUrl ? { targetRepoUrl } : {})}
          onStartInRepo={(repoUrl) => onStartSession(issue, repoUrl)}
          className="w-full @md:w-auto"
        />
      </div>
    </div>
  );
}

function TableHeader() {
  return (
    <div
      className={`${ROW_GRID} hidden @md:grid sticky top-0 z-10 px-3 py-1.5 bg-(--color-bg-secondary) border-b border-(--color-border-secondary) text-[10px] uppercase tracking-wide font-semibold text-(--color-text-tertiary)`}
    >
      <div className="[grid-area:id]">Issue</div>
      <div className="[grid-area:title]">Title</div>
      <div className="[grid-area:pri]">Priority</div>
      <div className="[grid-area:status]">Status</div>
      <div className="[grid-area:assignee]">Assignee</div>
      <div className="[grid-area:action] justify-self-center">Action</div>
    </div>
  );
}

export function IssuesViewer({
  trackers,
  activeTracker,
  issues,
  filteredIssues,
  desktopSections,
  mobileSections,
  sortPrefs,
  filters,
  statusOptions,
  assigneeOptions,
  labelOptions,
  priorityCounts,
  info,
  loading,
  error,
  canStart,
  repos,
  targetRepoUrl,
  includeDone,
  availableStatuses,
  canEditPriority,
  onSelectTracker,
  onRefresh,
  onToggleIncludeDone,
  onSetSortPrefs,
  onSetCollapsed,
  onOpenIssue,
  initialScrollTop,
  onPersistScroll,
  onSetStatus,
  onSetPriority,
  onStartSession,
  onConnect,
  onSetQuery,
  onTogglePriority,
  onToggleStatus,
  onToggleAssignee,
  onToggleLabel,
  onClearFilters,
}: IssuesViewerProps) {
  const activeInfo = info ?? trackers.find((t) => t.id === activeTracker);
  const configured = activeInfo?.configured ?? false;
  // Tracker declarations are briefly empty while a repo switch loads.
  const declarationsPending = trackers.length === 0 && loading;
  const filterActive = anyFilterActive(filters);
  const showFilterBar = configured && issues.length > 0;
  const rowSurfaceLum = useSurfaceLuminance("--color-bg-primary");
  const [sortOpen, setSortOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isNarrow = useNarrowContainer(scrollRef, CARD_BREAKPOINT_PX);
  const sections = isNarrow ? mobileSections : desktopSections;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = initialScrollTop;
    return () => onPersistScroll(el.scrollTop);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- Restore and save only at mount boundaries.
  }, []);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-stretch border-b border-(--color-border-secondary) bg-(--color-bg-secondary)">
        <div className="flex items-stretch">
          {trackers.map((t) => (
            <button
              key={t.id}
              onClick={() => onSelectTracker(t.id)}
              title={t.binding ? `${t.label} · ${t.binding.key}` : t.label}
              className={`px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer border-b-2 whitespace-nowrap ${
                activeTracker === t.id
                  ? "text-(--color-text-primary) border-(--color-accent)"
                  : "text-(--color-text-tertiary) border-transparent hover:text-(--color-text-secondary)"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        <div className="flex items-center gap-2 px-3 text-xs text-(--color-text-secondary)">
          <span className="font-medium whitespace-nowrap" data-testid="issue-count">
            {declarationsPending ? (
              ""
            ) : !configured ? (
              "Not connected"
            ) : filterActive ? (
              <>
                <b className="text-(--color-text-primary)">{filteredIssues.length}</b> of {issues.length}{" "}
                <span className="hidden sm:inline">
                  issue{issues.length !== 1 ? "s" : ""}
                </span>
              </>
            ) : (
              `${issues.length} issue${issues.length !== 1 ? "s" : ""}`
            )}
          </span>
          {configured && (
            <Button
              variant="ghost"
              size="md"
              onClick={onToggleIncludeDone}
              disabled={loading}
              aria-pressed={includeDone}
              title={includeDone ? "Hide done issues" : "Show done issues"}
              className={`inline-flex items-center gap-1.5 ${
                includeDone ? "text-(--color-text-primary)" : ""
              }`}
            >
              <CheckCircleIcon
                size={ICON_SIZE.SM}
                weight={includeDone ? "fill" : "regular"}
                className={includeDone ? "text-(--color-accent)" : ""}
              />
              <span className="hidden sm:inline">Show done</span>
            </Button>
          )}
          {configured && (
            <Button
              variant="ghost"
              size="md"
              onClick={() => setSortOpen(true)}
              title={`Sort & group — ${describeSort(sortPrefs)}`}
              aria-label="Sort and group issues"
              className="relative inline-flex items-center gap-1.5"
            >
              <SlidersHorizontalIcon size={ICON_SIZE.SM} />
              {isNonDefaultSort(sortPrefs) && (
                <span
                  className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-(--color-accent)"
                  aria-hidden="true"
                />
              )}
            </Button>
          )}
          <Button
            variant="ghost"
            size="md"
            onClick={onRefresh}
            disabled={loading}
            title="Refresh issues"
            className="inline-flex items-center gap-1.5"
          >
            {loading
              ? <Spinner size={ICON_SIZE.SM} />
              : <ArrowClockwiseIcon size={ICON_SIZE.SM} />}
            <span className="hidden sm:inline">Refresh</span>
          </Button>
        </div>
      </div>

      {showFilterBar && (
        <IssuesFilterBar
          filters={filters}
          statusOptions={statusOptions}
          assigneeOptions={assigneeOptions}
          labelOptions={labelOptions}
          priorityCounts={priorityCounts}
          onSetQuery={onSetQuery}
          onTogglePriority={onTogglePriority}
          onToggleStatus={onToggleStatus}
          onToggleAssignee={onToggleAssignee}
          onToggleLabel={onToggleLabel}
        />
      )}

      <div ref={scrollRef} className="@container flex-1 overflow-auto">
        {error && (
          <div className="flex items-start gap-2 m-3 p-3 rounded bg-(--color-error-subtle) text-(--color-error) text-xs">
            <WarningCircleIcon size={ICON_SIZE.SM} className="shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {declarationsPending ? (
          <div className="flex items-center justify-center h-full text-(--color-text-tertiary) text-sm">
            Loading issues…
          </div>
        ) : !configured ? (
          isGitHubTracker(activeTracker) ? (
            <div className="flex items-center justify-center h-full text-center px-6">
              <div className="space-y-3 max-w-xs">
                <PlugIcon size={ICON_SIZE.XL} className="mx-auto text-(--color-text-tertiary)" />
                <p className="text-lg font-medium text-(--color-text-secondary)">No GitHub repo in context</p>
                <p className="text-xs text-(--color-text-tertiary)">
                  GitHub issues come from the active session's repository. Open a session on a
                  GitHub-hosted repo (and connect GitHub if you haven't) to see its issues here.
                </p>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-center px-6">
              <div className="space-y-3 max-w-xs">
                <PlugIcon size={ICON_SIZE.XL} className="mx-auto text-(--color-text-tertiary)" />
                <p className="text-lg font-medium text-(--color-text-secondary)">
                  Connect {activeInfo?.label ?? "Linear"}
                </p>
                <p className="text-xs text-(--color-text-tertiary)">
                  Add a {activeInfo?.label ?? "Linear"} API token and pick a team to see your
                  prioritized issues here and start a session from any of them.
                </p>
                <Button variant="primary" size="md" onClick={onConnect}>
                  Connect {activeInfo?.label ?? "Linear"}
                </Button>
              </div>
            </div>
          )
        ) : issues.length === 0 && !loading ? (
          <div className="flex items-center justify-center h-full text-(--color-text-tertiary) text-sm">
            No {includeDone ? "" : "open "}issues in {activeInfo?.binding?.name ?? "this team"}.
          </div>
        ) : filteredIssues.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-6">
            <p className="text-sm text-(--color-text-secondary)">No issues match your filters.</p>
            <Button variant="secondary" size="md" onClick={onClearFilters}>
              Clear filters
            </Button>
          </div>
        ) : (
          <>
            <TableHeader />
            {sections.map((section, si) => {
              const rootCount = section.rows.filter((r) => r.depth === 0).length;
              return (
                <div key={section.label ?? `__all-${si}`}>
                  {section.label !== null && (
                    <div className="flex items-center gap-2 px-3 py-1.5 bg-(--color-bg-secondary) border-b border-(--color-border-primary) text-[11px] font-semibold uppercase tracking-wide text-(--color-text-secondary)">
                      <span className="truncate">{section.label}</span>
                      <span className="text-(--color-text-tertiary)">{rootCount}</span>
                    </div>
                  )}
                  <div className="divide-y divide-(--color-border-primary)">
                    {section.rows.map((row) => (
                      <IssueRow
                        key={row.issue.id}
                        row={row}
                        canStart={canStart}
                        repos={repos}
                        {...(targetRepoUrl ? { targetRepoUrl } : {})}
                        availableStatuses={availableStatuses}
                        canEditPriority={canEditPriority}
                        surfaceLum={rowSurfaceLum}
                        onOpenIssue={onOpenIssue}
                        onSetCollapsed={onSetCollapsed}
                        onSetStatus={onSetStatus}
                        onSetPriority={onSetPriority}
                        onStartSession={onStartSession}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>

      <IssuesSortModal open={sortOpen} onOpenChange={setSortOpen} prefs={sortPrefs} onChange={onSetSortPrefs} />
    </div>
  );
}
