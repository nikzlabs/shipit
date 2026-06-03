import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  PlugIcon,
  RocketLaunchIcon,
  UserIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
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
  issues: TrackerIssue[];
  /** Active tracker's info (configured + binding); falls back to `trackers`. */
  info?: TrackerInfo;
  loading: boolean;
  error: string | null;
  startingIds: Set<string>;
  /** Whether a repo is available to start a session on. */
  canStart: boolean;
  onSelectTracker: (id: TrackerId) => void;
  onRefresh: () => void;
  onStartSession: (issue: TrackerIssue) => void;
  /** Open Settings → Trackers so the user can connect/bind Linear. */
  onConnect: () => void;
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

function IssueRow({
  issue,
  starting,
  canStart,
  onStartSession,
}: {
  issue: TrackerIssue;
  starting: boolean;
  canStart: boolean;
  onStartSession: (issue: TrackerIssue) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-2 px-3 py-2 hover:bg-(--color-bg-hover) transition-colors group/row">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <a
            href={issue.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1 text-[11px] font-mono text-(--color-text-tertiary) hover:text-(--color-text-secondary)"
            title={`Open ${issue.identifier} in the tracker`}
          >
            {issue.identifier}
            <ArrowSquareOutIcon size={ICON_SIZE.XS} />
          </a>
          <PriorityBadge priority={issue.priority} />
        </div>
        <div className="text-sm text-(--color-text-primary) truncate">{issue.title}</div>
        <div className="flex items-center gap-2 mt-0.5 text-[11px] text-(--color-text-tertiary)">
          {issue.status && <span>{issue.status.name}</span>}
          {issue.assignee && (
            <span className="inline-flex items-center gap-1">
              <UserIcon size={ICON_SIZE.XS} />
              {issue.assignee.name}
            </span>
          )}
        </div>
      </div>
      <Button
        variant="secondary"
        size="sm"
        disabled={starting || !canStart}
        title={canStart ? "Start a ShipIt session from this issue" : "Add a repo first to start a session"}
        onClick={() => onStartSession(issue)}
        className="shrink-0 inline-flex items-center gap-1.5"
      >
        <RocketLaunchIcon size={ICON_SIZE.SM} />
        {starting ? "Starting…" : "Start session"}
      </Button>
    </div>
  );
}

export function IssuesViewer({
  trackers,
  activeTracker,
  issues,
  info,
  loading,
  error,
  startingIds,
  canStart,
  onSelectTracker,
  onRefresh,
  onStartSession,
  onConnect,
}: IssuesViewerProps) {
  const activeInfo = info ?? trackers.find((t) => t.id === activeTracker);
  const configured = activeInfo?.configured ?? false;

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
          <span className="font-medium">
            {configured
              ? `${issues.length} issue${issues.length !== 1 ? "s" : ""}`
              : "Not connected"}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={onRefresh}
            disabled={loading}
            title="Refresh issues"
            className="inline-flex items-center gap-1.5"
          >
            <ArrowClockwiseIcon size={ICON_SIZE.SM} className={loading ? "animate-spin" : ""} />
            Refresh
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {error && (
          <div className="flex items-start gap-2 m-3 p-3 rounded bg-(--color-error-subtle) text-(--color-error) text-xs">
            <WarningCircleIcon size={ICON_SIZE.SM} className="shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {!configured ? (
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
        ) : issues.length === 0 && !loading ? (
          <div className="flex items-center justify-center h-full text-(--color-text-tertiary) text-sm">
            No open issues in {activeInfo?.binding?.name ?? "this team"}.
          </div>
        ) : (
          <div className="divide-y divide-(--color-border-secondary)">
            {issues.map((issue) => (
              <IssueRow
                key={issue.id}
                issue={issue}
                starting={startingIds.has(issue.id)}
                canStart={canStart}
                onStartSession={onStartSession}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
