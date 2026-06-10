/**
 * IssueDetail — the inline single-issue view (docs/189).
 *
 * The detail half of the Issues tab's master-detail layout. It renders a
 * fully-hydrated tracker issue — title, status, priority, labels, assignee, and
 * the markdown body — entirely inside ShipIt, so reading an issue never bounces
 * the user to Linear/GitHub. Reached three ways, all routed through
 * `issues-store.openIssue`: a list row, the agent's read card (`IssueRefCard`),
 * and the agent's write card (`IssueWriteCard`).
 *
 * Per the ShipIt product principles (CLAUDE.md §2), the deep link to the tracker
 * is an *escape hatch* that lives ONLY here, in the header — it's no longer the
 * primary affordance on the list rows or the chat cards.
 *
 * Presentational: the connected `IssuesPanel` selects the store state and wires
 * the callbacks. While the fresh fetch is in flight the view paints from the
 * seed fields the opener already had (`selection`), so a click feels instant.
 */

import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  CaretLeftIcon,
  RocketLaunchIcon,
  TagIcon,
  UserIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { MarkdownContent } from "./message-markdown.js";
import { ICON_SIZE } from "../design-tokens.js";
import type { IssueSelection } from "../stores/issues-store.js";
import type {
  IssuePriorityLevel,
  TrackerInfo,
  TrackerIssue,
} from "../../server/shared/types.js";

export interface IssueDetailProps {
  selection: IssueSelection;
  /** Fully-hydrated issue from `GET /api/issue`; null until the fetch lands. */
  detail: TrackerIssue | null;
  loading: boolean;
  error: string | null;
  /** Active tracker info, for the "Open in {label}" deep link. */
  info?: TrackerInfo;
  /** Whether a repo is available to seed a session on. */
  canStart: boolean;
  onBack: () => void;
  onRefresh: () => void;
  onStartSession: (issue: TrackerIssue) => void;
}

const PRIORITY_VARIANT: Record<IssuePriorityLevel, "default" | "error" | "warning" | "info"> = {
  urgent: "error",
  high: "warning",
  medium: "info",
  low: "default",
  none: "default",
};

/**
 * Status accent by normalized workflow-state type. Both trackers normalize onto
 * the same vocabulary (Linear's six types, GitHub's open→started / closed→
 * completed), so a single mapping colors the status dot + label across both.
 */
function statusTone(type?: string): { dot: string; text: string } {
  switch (type) {
    case "completed":
      return { dot: "bg-(--color-success)", text: "text-(--color-success)" };
    case "canceled":
      return { dot: "bg-(--color-text-tertiary)", text: "text-(--color-text-tertiary)" };
    case "started":
      return { dot: "bg-(--color-accent)", text: "text-(--color-text-primary)" };
    case "unstarted":
    case "backlog":
    case "triage":
    default:
      return { dot: "bg-(--color-text-tertiary)", text: "text-(--color-text-secondary)" };
  }
}

function StatusPill({ status }: { status: NonNullable<TrackerIssue["status"]> }) {
  const tone = statusTone(status.type);
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium">
      <span className={`h-2 w-2 rounded-full ${tone.dot}`} aria-hidden="true" />
      <span className={tone.text}>{status.name}</span>
    </span>
  );
}

function PriorityBadge({ priority }: { priority: TrackerIssue["priority"] }) {
  if (priority.level === "none") return null;
  return (
    <Badge variant={PRIORITY_VARIANT[priority.level]} className="h-[18px] text-[11px]">
      {priority.label}
    </Badge>
  );
}

export function IssueDetail({
  selection,
  detail,
  loading,
  error,
  info,
  canStart,
  onBack,
  onRefresh,
  onStartSession,
}: IssueDetailProps) {
  // Prefer the hydrated issue; fall back to the seed fields the opener supplied
  // so the header/title paint before the fetch resolves.
  const title = detail?.title ?? selection.title ?? selection.identifier;
  const url = detail?.url ?? selection.url;
  const trackerLabel = info?.label ?? (selection.tracker === "github" ? "GitHub" : "Linear");
  // A card-opened issue with no seed and no detail yet has nothing to show but
  // the identifier — render the skeleton until the first fetch lands.
  const showSkeleton = loading && !detail;

  return (
    <div className="flex flex-col h-full animate-in fade-in-0 duration-200">
      {/* Header: back · identifier · external escape hatch. */}
      <div className="flex items-center gap-2 px-3 h-11 shrink-0 border-b border-(--color-border-secondary) bg-(--color-bg-secondary)">
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="shrink-0 -ml-1"
          title="Back to issues"
        >
          <CaretLeftIcon size={ICON_SIZE.SM} />
          Issues
        </Button>

        <span className="font-mono text-xs text-(--color-text-tertiary) truncate">
          {selection.identifier}
        </span>

        <div className="flex-1" />

        <Button
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          disabled={loading}
          title="Refresh issue"
          className="shrink-0"
        >
          <ArrowClockwiseIcon size={ICON_SIZE.SM} className={loading ? "animate-spin" : ""} />
        </Button>

        {url && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            title={`Open ${selection.identifier} in ${trackerLabel}`}
            className="shrink-0 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-(--color-text-secondary) hover:text-(--color-text-primary) hover:bg-(--color-bg-hover) transition-colors"
          >
            <ArrowSquareOutIcon size={ICON_SIZE.XS} />
            <span className="hidden sm:inline">Open in {trackerLabel}</span>
          </a>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {error && !detail ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-6">
            <WarningCircleIcon size={ICON_SIZE.XL} className="text-(--color-text-tertiary)" />
            <p className="text-sm text-(--color-text-secondary)">{error}</p>
            <Button variant="secondary" size="sm" onClick={onRefresh}>
              Try again
            </Button>
          </div>
        ) : showSkeleton ? (
          <IssueDetailSkeleton />
        ) : (
          <article className="px-5 py-5">
            {/* Status · priority strip. */}
            <div className="flex items-center flex-wrap gap-3 mb-3">
              {detail?.status && <StatusPill status={detail.status} />}
              {detail && <PriorityBadge priority={detail.priority} />}
            </div>

            {/* Title. */}
            <h1 className="text-xl font-semibold leading-snug text-(--color-text-primary) mb-4">
              {title}
            </h1>

            {/* Assignee + labels meta. */}
            {(Boolean(detail?.assignee) || (detail?.labels?.length ?? 0) > 0) && (
              <div className="flex flex-col gap-2.5 pb-4 mb-4 border-b border-(--color-border-secondary)">
                {detail?.assignee && (
                  <div className="flex items-center gap-2 text-xs text-(--color-text-secondary)">
                    <UserIcon size={ICON_SIZE.SM} className="text-(--color-text-tertiary)" />
                    {detail.assignee.avatarUrl ? (
                      <img
                        src={detail.assignee.avatarUrl}
                        alt=""
                        className="w-5 h-5 rounded-full object-cover"
                      />
                    ) : null}
                    <span className="text-(--color-text-primary)">{detail.assignee.name}</span>
                  </div>
                )}
                {detail?.labels && detail.labels.length > 0 && (
                  <div className="flex items-start gap-2">
                    <TagIcon size={ICON_SIZE.SM} className="text-(--color-text-tertiary) mt-0.5 shrink-0" />
                    <div className="flex flex-wrap gap-1.5">
                      {detail.labels.map((label) => (
                        <span
                          key={label}
                          className="inline-flex items-center rounded-full bg-(--color-bg-tertiary) text-(--color-text-secondary) text-[11px] px-2 py-0.5"
                        >
                          {label}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Body. */}
            {detail?.description?.trim() ? (
              <MarkdownContent text={detail.description} />
            ) : (
              <p className="text-sm text-(--color-text-tertiary) italic">No description.</p>
            )}
          </article>
        )}
      </div>

      {/* Footer action — seed a session from this issue (mirrors the list row). */}
      {detail && (
        <div className="shrink-0 border-t border-(--color-border-secondary) bg-(--color-bg-secondary) px-4 py-2.5">
          <Button
            variant="secondary"
            size="sm"
            disabled={!canStart}
            onClick={() => onStartSession(detail)}
            title={canStart ? "Seed a ShipIt session prompt from this issue" : "Add a repo first to start a session"}
            className="inline-flex items-center gap-1.5"
          >
            <RocketLaunchIcon size={ICON_SIZE.SM} />
            Start session from this issue
          </Button>
        </div>
      )}
    </div>
  );
}

/** Loading placeholder for a card-opened issue we have no seed for yet. */
function IssueDetailSkeleton() {
  return (
    <div className="px-5 py-5 animate-pulse" data-testid="issue-detail-skeleton">
      <div className="flex items-center gap-3 mb-3">
        <div className="h-3 w-20 rounded bg-(--color-bg-tertiary)" />
        <div className="h-3 w-12 rounded bg-(--color-bg-tertiary)" />
      </div>
      <div className="h-6 w-3/4 rounded bg-(--color-bg-tertiary) mb-5" />
      <div className="space-y-2.5">
        <div className="h-3 w-full rounded bg-(--color-bg-tertiary)" />
        <div className="h-3 w-11/12 rounded bg-(--color-bg-tertiary)" />
        <div className="h-3 w-4/5 rounded bg-(--color-bg-tertiary)" />
      </div>
    </div>
  );
}
