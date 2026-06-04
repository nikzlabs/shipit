import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  CheckCircleIcon,
  PlugIcon,
  RocketLaunchIcon,
  UserIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { IssuesFilterBar } from "./IssuesFilterBar.js";
import { anyFilterActive, type AssigneeOption, type IssueFilters, type StatusOption } from "./issues-filter.js";
import { ICON_SIZE } from "../design-tokens.js";
import type {
  IssuePriorityLevel,
  TrackerId,
  TrackerInfo,
  TrackerIssue,
} from "../../server/shared/types.js";

export interface IssuesViewerProps {
  trackers: TrackerInfo[];
  activeTracker: TrackerId;
  /** Full loaded list (the "M" in "N of M"); the source for derived facets. */
  issues: TrackerIssue[];
  /** Filtered subset actually rendered as rows (the "N"). */
  filteredIssues: TrackerIssue[];
  filters: IssueFilters;
  statusOptions: StatusOption[];
  assigneeOptions: AssigneeOption[];
  priorityCounts: Record<IssuePriorityLevel, number>;
  /** Active tracker's info (configured + binding); falls back to `trackers`. */
  info?: TrackerInfo;
  loading: boolean;
  error: string | null;
  /** Whether a repo is available to start a session on. */
  canStart: boolean;
  /** Whether the loaded list includes done/completed issues (fetch-scope). */
  includeDone: boolean;
  onSelectTracker: (id: TrackerId) => void;
  onRefresh: () => void;
  onToggleIncludeDone: () => void;
  onStartSession: (issue: TrackerIssue) => void;
  /** Open Settings → Trackers so the user can connect/bind Linear. */
  onConnect: () => void;
  onSetQuery: (query: string) => void;
  onTogglePriority: (level: IssuePriorityLevel) => void;
  onToggleStatus: (name: string) => void;
  onToggleAssignee: (value: string) => void;
  onClearFilters: () => void;
}

/** Priority badge variant + ordering hint, by normalized level. */
const PRIORITY_VARIANT: Record<IssuePriorityLevel, "default" | "error" | "warning" | "info"> = {
  urgent: "error",
  high: "warning",
  medium: "info",
  low: "default",
  none: "default",
};

function PriorityBadge({ priority }: { priority: TrackerIssue["priority"] }) {
  if (priority.level === "none") return null;
  return (
    <Badge variant={PRIORITY_VARIANT[priority.level]} className="h-[18px] text-[11px]">
      {priority.label}
    </Badge>
  );
}

function AssigneeLabel({ assignee }: { assignee: NonNullable<TrackerIssue["assignee"]> }) {
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0">
      {assignee.avatarUrl ? (
        <img src={assignee.avatarUrl} alt="" className="shrink-0 w-[18px] h-[18px] rounded-full object-cover" />
      ) : (
        <UserIcon size={ICON_SIZE.XS} className="shrink-0 text-(--color-text-tertiary)" />
      )}
      <span className="truncate">{assignee.name}</span>
    </span>
  );
}

/**
 * Grid template that reflows responsively (docs/173). A single DOM row whose
 * cells are placed by `grid-area`, so there's no duplicated markup between the
 * desktop table and the mobile card:
 *   - mobile (<md): stacked card — id+priority, then title, then status·assignee,
 *     then a full-width action.
 *   - md..lg: tabular, Assignee column dropped.
 *   - lg+: full table with the Assignee column.
 * Title never drops; the action is always present.
 */
// The action track is a FIXED width (not `auto`) so the header grid and each
// row grid — which are independent grid containers — resolve to identical
// column tracks. With `auto`, the header sized that column to the "Action"
// label while rows sized it to the wider "Start session" button; the `1fr`
// title column absorbed the difference, shifting every trailing column out of
// alignment between header and rows.
const ROW_GRID =
  "grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 " +
  "[grid-template-areas:'id_pri'_'title_title'_'meta_meta'_'action_action'] " +
  "md:grid-cols-[64px_minmax(0,1fr)_88px_104px_136px] md:gap-x-3 md:items-start " +
  "md:[grid-template-areas:'id_title_pri_status_action'] " +
  "lg:grid-cols-[64px_minmax(0,1fr)_88px_104px_96px_136px] " +
  "lg:[grid-template-areas:'id_title_pri_status_assignee_action']";

function IssueRow({
  issue,
  canStart,
  onStartSession,
}: {
  issue: TrackerIssue;
  canStart: boolean;
  onStartSession: (issue: TrackerIssue) => void;
}) {
  return (
    <div className={`${ROW_GRID} px-3 py-2.5 hover:bg-(--color-bg-hover) transition-colors`}>
      {/* Issue identifier — links to the issue in the tracker (escape hatch). */}
      <a
        href={issue.url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        title={`Open ${issue.identifier} in the tracker`}
        className="[grid-area:id] inline-flex items-center gap-1 text-[11px] font-mono text-(--color-text-tertiary) hover:text-(--color-text-secondary) self-start"
      >
        {issue.identifier}
        <ArrowSquareOutIcon size={ICON_SIZE.XS} />
      </a>

      {/* Title (+ optional description preview), wraps to two lines. */}
      <div className="[grid-area:title] min-w-0">
        <div className="text-sm text-(--color-text-primary) line-clamp-2">{issue.title}</div>
        {issue.description && (
          <div className="text-[11px] text-(--color-text-tertiary) line-clamp-1 mt-0.5">
            {issue.description}
          </div>
        )}
      </div>

      {/* Priority — right-aligned on mobile, column-aligned on desktop. */}
      <div className="[grid-area:pri] justify-self-end md:justify-self-start self-start">
        <PriorityBadge priority={issue.priority} />
      </div>

      {/* Status — its own column on desktop; folded into the meta line on mobile. */}
      <div className="hidden md:block [grid-area:status] text-xs text-(--color-text-secondary) truncate self-start">
        {issue.status?.name}
      </div>

      {/* Assignee — own column at lg+, hidden in the md..lg band, in the meta line on mobile. */}
      <div className="hidden lg:flex [grid-area:assignee] text-xs text-(--color-text-secondary) min-w-0 self-start">
        {issue.assignee && <AssigneeLabel assignee={issue.assignee} />}
      </div>

      {/* Mobile-only meta line: status · assignee. */}
      <div className="md:hidden [grid-area:meta] flex items-center gap-1.5 text-[11px] text-(--color-text-tertiary) min-w-0">
        {issue.status && <span className="truncate">{issue.status.name}</span>}
        {issue.status && issue.assignee && <span aria-hidden="true">·</span>}
        {issue.assignee && <AssigneeLabel assignee={issue.assignee} />}
      </div>

      <Button
        variant="secondary"
        size="sm"
        disabled={!canStart}
        title={canStart ? "Seed a ShipIt session prompt from this issue" : "Add a repo first to start a session"}
        onClick={() => onStartSession(issue)}
        className="[grid-area:action] w-full md:w-auto justify-self-stretch md:justify-self-end inline-flex items-center gap-1.5 self-start"
      >
        <RocketLaunchIcon size={ICON_SIZE.SM} />
        Start session
      </Button>
    </div>
  );
}

/** Sticky table header — desktop only; mobile rows are cards with no header. */
function TableHeader() {
  return (
    <div
      className={`${ROW_GRID} hidden md:grid sticky top-0 z-10 px-3 py-1.5 bg-(--color-bg-secondary) border-b border-(--color-border-secondary) text-[10px] uppercase tracking-wide font-semibold text-(--color-text-tertiary)`}
    >
      <div className="[grid-area:id]">Issue</div>
      <div className="[grid-area:title]">Title</div>
      <div className="[grid-area:pri]">Priority</div>
      <div className="[grid-area:status]">Status</div>
      <div className="hidden lg:block [grid-area:assignee]">Assignee</div>
      <div className="[grid-area:action] justify-self-end">Action</div>
    </div>
  );
}

export function IssuesViewer({
  trackers,
  activeTracker,
  issues,
  filteredIssues,
  filters,
  statusOptions,
  assigneeOptions,
  priorityCounts,
  info,
  loading,
  error,
  canStart,
  includeDone,
  onSelectTracker,
  onRefresh,
  onToggleIncludeDone,
  onStartSession,
  onConnect,
  onSetQuery,
  onTogglePriority,
  onToggleStatus,
  onToggleAssignee,
  onClearFilters,
}: IssuesViewerProps) {
  const activeInfo = info ?? trackers.find((t) => t.id === activeTracker);
  const configured = activeInfo?.configured ?? false;
  const filterActive = anyFilterActive(filters);
  const showFilterBar = configured && issues.length > 0;

  return (
    <div className="flex flex-col h-full">
      {/* Single top bar: tracker sub-tabs · spacer · issue count · refresh */}
      <div className="flex items-stretch border-b border-(--color-border-secondary) bg-(--color-bg-secondary)">
        {/* Sub-tab switcher — one per configured tracker (only Linear in v1). */}
        <div className="flex items-stretch">
          {trackers.map((t) => (
            <button
              key={t.id}
              onClick={() => onSelectTracker(t.id)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer border-b-2 ${
                activeTracker === t.id
                  ? "text-(--color-text-primary) border-(--color-accent)"
                  : "text-(--color-text-tertiary) border-transparent hover:text-(--color-text-secondary)"
              }`}
            >
              {t.label}
              {t.binding && (
                <span className="ml-1 text-(--color-text-tertiary)">· {t.binding.key}</span>
              )}
            </button>
          ))}
        </div>

        {/* Empty space */}
        <div className="flex-1" />

        {/* Issue count + refresh */}
        <div className="flex items-center gap-2 px-3 text-xs text-(--color-text-secondary)">
          <span className="font-medium whitespace-nowrap" data-testid="issue-count">
            {!configured ? (
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
              size="sm"
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
          <Button
            variant="ghost"
            size="sm"
            onClick={onRefresh}
            disabled={loading}
            title="Refresh issues"
            className="inline-flex items-center gap-1.5"
          >
            <ArrowClockwiseIcon size={ICON_SIZE.SM} className={loading ? "animate-spin" : ""} />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
        </div>
      </div>

      {showFilterBar && (
        <IssuesFilterBar
          filters={filters}
          statusOptions={statusOptions}
          assigneeOptions={assigneeOptions}
          priorityCounts={priorityCounts}
          onSetQuery={onSetQuery}
          onTogglePriority={onTogglePriority}
          onToggleStatus={onToggleStatus}
          onToggleAssignee={onToggleAssignee}
        />
      )}

      <div className="flex-1 overflow-y-auto">
        {error && (
          <div className="flex items-start gap-2 m-3 p-3 rounded bg-(--color-error-subtle) text-(--color-error) text-xs">
            <WarningCircleIcon size={ICON_SIZE.SM} className="shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {!configured ? (
          activeTracker === "github" ? (
            // GitHub needs no connect step — it reuses ShipIt's GitHub auth and
            // scopes to the active session's repo. So "not configured" means
            // there's no GitHub repo in context, not a missing credential.
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
                <Button variant="primary" size="sm" onClick={onConnect}>
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
            <Button variant="secondary" size="sm" onClick={onClearFilters}>
              Clear filters
            </Button>
          </div>
        ) : (
          <>
            <TableHeader />
            <div className="divide-y divide-(--color-border-secondary)">
              {filteredIssues.map((issue) => (
                <IssueRow
                  key={issue.id}
                  issue={issue}
                  canStart={canStart}
                  onStartSession={onStartSession}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
