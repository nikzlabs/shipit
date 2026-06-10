import {
  ArrowClockwiseIcon,
  CaretRightIcon,
  CheckCircleIcon,
  PlugIcon,
  UserIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { StartSessionButton } from "./StartSessionButton.js";
import { IssuesFilterBar } from "./IssuesFilterBar.js";
import {
  IssuePriorityEditor,
  IssueStatusEditor,
  PriorityTrigger,
  statusDotClass,
  type IssueStatusRef,
} from "./IssueFieldControls.js";
import { anyFilterActive, type AssigneeOption, type IssueFilters, type StatusOption } from "./issues-filter.js";
import { labelDotColor } from "./issue-label-color.js";
import { cn } from "../utils/cn.js";
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
  /** The active tracker's assignable statuses, for the inline status editor (docs/191). */
  availableStatuses: IssueStatusRef[];
  /** Whether priority is editable for the active tracker (Linear yes, GitHub no). */
  canEditPriority: boolean;
  onSelectTracker: (id: TrackerId) => void;
  onRefresh: () => void;
  onToggleIncludeDone: () => void;
  /** Open the inline detail view for a row (docs/189). */
  onOpenIssue: (issue: TrackerIssue) => void;
  /** Set a row's status inline; resolves to an error message, or null (docs/191). */
  onSetStatus: (issue: TrackerIssue, status: string) => Promise<string | null>;
  /** Set a row's priority inline (Linear-only); resolves to an error, or null. */
  onSetPriority: (issue: TrackerIssue, level: IssuePriorityLevel) => Promise<string | null>;
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

/**
 * Compact identifier for the narrow ID column. GitHub identifiers are
 * `owner/repo#123`, which overflow the 64px track and collide with the title
 * (the full form survives in the link tooltip). Strip the repo path and the `#`
 * so only the bare `123` shows; Linear identifiers (`SHI-1`, no `#`) pass
 * through unchanged.
 */
function shortIdentifier(identifier: string): string {
  const hash = identifier.indexOf("#");
  return hash === -1 ? identifier : identifier.slice(hash + 1);
}

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

/**
 * Label chips shown under the issue title (SHI-92). Each chip pairs a
 * deterministic colored dot (so labels are visually distinguishable at a glance —
 * neither tracker gives us a label color on the list path) with the label name
 * in token-driven text, keeping the chip legible in every theme. We cap the row
 * at a handful of chips and roll the rest into a "+N" so a heavily-labeled issue
 * never blows out the title cell.
 */
const MAX_LABELS = 4;

function IssueLabels({ labels }: { labels?: string[] }) {
  if (!labels || labels.length === 0) return null;
  const shown = labels.slice(0, MAX_LABELS);
  const overflow = labels.length - shown.length;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1">
      {shown.map((label) => (
        <span
          key={label}
          className="inline-flex items-center gap-1 max-w-[160px] rounded-full border border-(--color-border-primary) bg-(--color-bg-secondary) pl-1.5 pr-2 py-px text-[10px] font-medium text-(--color-text-secondary)"
        >
          <span
            className="size-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: labelDotColor(label) }}
            aria-hidden="true"
          />
          <span className="truncate">{label}</span>
        </span>
      ))}
      {overflow > 0 && (
        <span className="text-[10px] font-medium text-(--color-text-tertiary)" title={labels.slice(MAX_LABELS).join(", ")}>
          +{overflow}
        </span>
      )}
    </div>
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

// Every cell's FIRST line shares one fixed-height band, vertically centered, so
// the row's leading line (id · title · priority · status · assignee · action)
// reads as a single baseline regardless of each cell's inner element height —
// the 11px id, the 14px title, the 18px priority pill, the dot+text status, and
// the 20px button would otherwise each top-align at a slightly different center
// (the row is `items-start`). 24px clears the tallest inner element (the
// editor-trigger-wrapped priority badge). The title uses `min-h-6` instead so a
// two-line title can still grow downward; its description + labels flow below.
const FIRST_LINE = "flex items-center h-6";

function IssueRow({
  issue,
  canStart,
  availableStatuses,
  canEditPriority,
  onOpenIssue,
  onSetStatus,
  onSetPriority,
  onStartSession,
}: {
  issue: TrackerIssue;
  canStart: boolean;
  availableStatuses: IssueStatusRef[];
  canEditPriority: boolean;
  onOpenIssue: (issue: TrackerIssue) => void;
  onSetStatus: (issue: TrackerIssue, status: string) => Promise<string | null>;
  onSetPriority: (issue: TrackerIssue, level: IssuePriorityLevel) => Promise<string | null>;
  onStartSession: (issue: TrackerIssue) => void;
}) {
  return (
    // The whole row opens the inline detail view (docs/189) — the deep link to
    // the tracker now lives only inside that view, not on the row. A div with a
    // button role (not a <button>) so the nested "Start session" button is legal.
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
      className={`${ROW_GRID} group relative px-3 py-3 cursor-pointer transition-colors focus:outline-none hover:bg-(--color-bg-hover) focus-visible:bg-(--color-bg-hover) before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:rounded-r before:bg-(--color-accent) before:opacity-0 before:transition-opacity group-hover:before:opacity-100 focus-visible:before:opacity-100`}
    >
      {/* Issue identifier — plain label; the row click (not this) opens detail. */}
      <span className={`[grid-area:id] ${FIRST_LINE} text-[11px] font-mono text-(--color-text-tertiary) group-hover:text-(--color-text-secondary) transition-colors min-w-0`}>
        <span className="truncate">{shortIdentifier(issue.identifier)}</span>
      </span>

      {/* Title (+ optional description preview + labels), wraps to two lines. */}
      <div className="[grid-area:title] min-w-0">
        <div className="flex items-center min-h-6 gap-1 text-sm font-medium text-(--color-text-primary)">
          <span className="line-clamp-2">{issue.title}</span>
          <CaretRightIcon
            size={ICON_SIZE.XS}
            className="shrink-0 text-(--color-text-tertiary) opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition-all"
          />
        </div>
        {issue.description && (
          <div className="text-[11px] text-(--color-text-tertiary) line-clamp-1 mt-0.5">
            {issue.description}
          </div>
        )}
        <IssueLabels labels={issue.labels} />
      </div>

      {/* Priority — right-aligned on mobile, column-aligned on desktop. Inline-
          editable for Linear (docs/191); read-only badge for GitHub. */}
      <div className={`[grid-area:pri] ${FIRST_LINE} justify-self-end md:justify-self-start`}>
        {canEditPriority ? (
          <IssuePriorityEditor
            current={issue.priority.level}
            onSelect={(level) => onSetPriority(issue, level)}
            ariaLabel={`Change priority of ${issue.identifier} (currently ${issue.priority.label})`}
            trigger={<PriorityTrigger priority={issue.priority} />}
            align="end"
          />
        ) : (
          <PriorityBadge priority={issue.priority} />
        )}
      </div>

      {/* Status — its own column on desktop; folded into the meta line on mobile.
          Inline-editable (docs/191). */}
      <div className="hidden md:flex items-center h-6 [grid-area:status] text-xs text-(--color-text-secondary) min-w-0">
        {issue.status && (
          <IssueStatusEditor
            current={issue.status}
            options={availableStatuses}
            onSelect={(name) => onSetStatus(issue, name)}
            ariaLabel={`Change status of ${issue.identifier} (currently ${issue.status.name})`}
            trigger={
              <span className="inline-flex items-center gap-1.5 min-w-0">
                <span
                  className={cn("size-2 shrink-0 rounded-full", statusDotClass(issue.status.type))}
                  aria-hidden="true"
                />
                <span className="truncate">{issue.status.name}</span>
              </span>
            }
          />
        )}
      </div>

      {/* Assignee — own column at lg+, hidden in the md..lg band, in the meta line on mobile. */}
      <div className="hidden lg:flex items-center h-6 [grid-area:assignee] text-xs text-(--color-text-secondary) min-w-0">
        {issue.assignee && <AssigneeLabel assignee={issue.assignee} />}
      </div>

      {/* Mobile-only meta line: status · assignee. */}
      <div className="md:hidden [grid-area:meta] flex items-center gap-1.5 text-[11px] text-(--color-text-tertiary) min-w-0">
        {issue.status && (
          <span className="inline-flex items-center gap-1.5 min-w-0">
            <span
              className={cn("size-1.5 shrink-0 rounded-full", statusDotClass(issue.status.type))}
              aria-hidden="true"
            />
            <span className="truncate">{issue.status.name}</span>
          </span>
        )}
        {issue.status && issue.assignee && <span aria-hidden="true">·</span>}
        {issue.assignee && <AssigneeLabel assignee={issue.assignee} />}
      </div>

      {/* Wrapped in the shared first-line band so the button centers on the same
          baseline as the other cells (the row is `items-start`). The cell fills
          the action track and `justify-end` pushes the button to the track's
          right edge — the same edge the `justify-self-end` header label sits on,
          so "Action" lines up with the button regardless of the button's width. */}
      <div className={`[grid-area:action] ${FIRST_LINE} w-full justify-end`}>
        <StartSessionButton
          disabled={!canStart}
          title={canStart ? "Seed a ShipIt session prompt from this issue" : "Add a repo first to start a session"}
          onClick={(e) => {
            e.stopPropagation();
            onStartSession(issue);
          }}
          className="w-full md:w-auto"
        />
      </div>
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
  availableStatuses,
  canEditPriority,
  onSelectTracker,
  onRefresh,
  onToggleIncludeDone,
  onOpenIssue,
  onSetStatus,
  onSetPriority,
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
            <div className="divide-y divide-(--color-border-primary)">
              {filteredIssues.map((issue) => (
                <IssueRow
                  key={issue.id}
                  issue={issue}
                  canStart={canStart}
                  availableStatuses={availableStatuses}
                  canEditPriority={canEditPriority}
                  onOpenIssue={onOpenIssue}
                  onSetStatus={onSetStatus}
                  onSetPriority={onSetPriority}
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
