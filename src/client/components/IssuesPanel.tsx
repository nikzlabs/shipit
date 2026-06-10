import { useMemo } from "react";
import { IssuesViewer } from "./IssuesViewer.js";
import { IssueDetail } from "./IssueDetail.js";
import {
  distinctAssignees,
  distinctStatuses,
  filterIssues,
  type AssigneeOption,
  type StatusOption,
} from "./issues-filter.js";
import type { IssueStatusRef } from "./IssueFieldControls.js";
import { useIssuesStore } from "../stores/issues-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { useRepoStore } from "../stores/repo-store.js";
import type { IssuePriorityLevel, TrackerId, TrackerIssue } from "../../server/shared/types.js";

/**
 * Stable empty references. Returning a fresh `[]`/`{}` literal from a Zustand
 * selector (or recomputing a derived array on every render) makes
 * `useSyncExternalStore` see a new snapshot each render, which loops into React
 * error #185 ("Maximum update depth exceeded") — exactly the state on tab open,
 * before the first fetch populates `issuesByTracker`. We select raw store state
 * and derive with `useMemo`, falling back to these shared constants when empty.
 */
const EMPTY_ISSUES: TrackerIssue[] = [];
const EMPTY_STATUSES: StatusOption[] = [];
const EMPTY_ASSIGNEES: AssigneeOption[] = [];
const EMPTY_STATUS_REFS: IssueStatusRef[] = [];

const ZERO_PRIORITY_COUNTS: Record<IssuePriorityLevel, number> = {
  urgent: 0,
  high: 0,
  medium: 0,
  low: 0,
  none: 0,
};

/**
 * Connected wrapper around {@link IssuesViewer} (docs/170 + docs/173). Resolves
 * the repo to start a session on (the current session's remote, falling back to
 * the active sidebar repo) to gate the Start-session action, and delegates the
 * action itself to the parent. Owns the client-side filter plumbing: it derives
 * the filtered list + distinct status/assignee facet options with stable
 * memoized references (see the EMPTY_* note above) and wires the store's filter
 * actions to the presentational viewer.
 */
export function IssuesPanel({
  onStartSession,
  onConnect,
}: {
  onStartSession: (issue: TrackerIssue) => void;
  onConnect: () => void;
}) {
  const trackers = useIssuesStore((s) => s.trackers);
  const activeTracker = useIssuesStore((s) => s.activeTracker);
  const issues = useIssuesStore((s) => s.issuesByTracker[s.activeTracker] ?? EMPTY_ISSUES);
  const info = useIssuesStore((s) => s.infoByTracker[s.activeTracker]);
  const availableStatuses = useIssuesStore(
    (s) => s.statusesByTracker[s.activeTracker] ?? EMPTY_STATUS_REFS,
  );
  const loading = useIssuesStore((s) => s.loading);
  const error = useIssuesStore((s) => s.error);
  const filters = useIssuesStore((s) => s.filters);
  const includeDone = useIssuesStore((s) => s.includeDone);
  const selected = useIssuesStore((s) => s.selected);
  const detail = useIssuesStore((s) => s.detail);
  const detailLoading = useIssuesStore((s) => s.detailLoading);
  const detailError = useIssuesStore((s) => s.detailError);
  const comments = useIssuesStore((s) => s.comments);
  const commentsLoading = useIssuesStore((s) => s.commentsLoading);
  const commentsError = useIssuesStore((s) => s.commentsError);

  // Derived, memoized so references stay stable across renders (React #185).
  const filteredIssues = useMemo(() => {
    const result = filterIssues(issues, filters);
    return result.length === 0 ? EMPTY_ISSUES : result;
  }, [issues, filters]);

  const statusOptions = useMemo(() => {
    const result = distinctStatuses(issues);
    return result.length === 0 ? EMPTY_STATUSES : result;
  }, [issues]);

  const assigneeOptions = useMemo(() => {
    const result = distinctAssignees(issues);
    return result.length === 0 ? EMPTY_ASSIGNEES : result;
  }, [issues]);

  const priorityCounts = useMemo(() => {
    if (issues.length === 0) return ZERO_PRIORITY_COUNTS;
    const counts: Record<IssuePriorityLevel, number> = { ...ZERO_PRIORITY_COUNTS };
    for (const issue of issues) counts[issue.priority.level] += 1;
    return counts;
  }, [issues]);

  // Repo to seed the session on: prefer the current session's remote so the
  // issue lands in the repo the user is already looking at; fall back to the
  // active sidebar repo when there's no session context yet.
  const repoUrl = useSessionStore((s) => {
    const current = s.sessions.find((sess) => sess.id === s.sessionId);
    return current?.remoteUrl;
  });
  const activeRepoUrl = useRepoStore((s) => s.activeRepoUrl);
  const effectiveRepoUrl = repoUrl || activeRepoUrl;

  const handleSelectTracker = (id: TrackerId) => {
    useIssuesStore.getState().setActiveTracker(id);
    void useIssuesStore.getState().fetchIssues(id);
  };

  const handleStartSession = (issue: TrackerIssue) => {
    if (!effectiveRepoUrl) return;
    onStartSession(issue);
  };

  // Master-detail (docs/189): a selected issue replaces the list with the
  // inline detail view. The list state stays mounted in the store, so the back
  // button returns to the same filtered scroll position the user left.
  if (selected) {
    const detailTracker = selected.tracker;
    return (
      <IssueDetail
        selection={selected}
        detail={detail}
        loading={detailLoading}
        error={detailError}
        info={info}
        canStart={Boolean(effectiveRepoUrl)}
        comments={comments}
        commentsLoading={commentsLoading}
        commentsError={commentsError}
        availableStatuses={availableStatuses}
        canEditPriority={detailTracker === "linear"}
        onBack={() => useIssuesStore.getState().closeIssue()}
        onRefresh={() => {
          // Refresh re-fetches both the issue body and its comment thread.
          void useIssuesStore.getState().fetchDetail();
          void useIssuesStore.getState().fetchComments();
        }}
        onStartSession={handleStartSession}
        onPostComment={(body) => useIssuesStore.getState().postComment(body)}
        onSetStatus={(status) => {
          // Read the live issue from the store so a refetch between renders
          // doesn't write against a stale snapshot.
          const open = useIssuesStore.getState().detail;
          if (!open) return Promise.resolve("No issue is open");
          return useIssuesStore.getState().setIssueStatus(detailTracker, open, status);
        }}
        onSetPriority={(level) => {
          const open = useIssuesStore.getState().detail;
          if (!open) return Promise.resolve("No issue is open");
          return useIssuesStore.getState().setIssuePriority(detailTracker, open, level);
        }}
      />
    );
  }

  return (
    <IssuesViewer
      trackers={trackers}
      activeTracker={activeTracker}
      issues={issues}
      filteredIssues={filteredIssues}
      filters={filters}
      statusOptions={statusOptions}
      assigneeOptions={assigneeOptions}
      priorityCounts={priorityCounts}
      info={info}
      loading={loading}
      error={error}
      canStart={Boolean(effectiveRepoUrl)}
      includeDone={includeDone}
      availableStatuses={availableStatuses}
      canEditPriority={activeTracker === "linear"}
      onSelectTracker={handleSelectTracker}
      onRefresh={() => void useIssuesStore.getState().fetchIssues()}
      onToggleIncludeDone={() => useIssuesStore.getState().toggleIncludeDone()}
      onSetStatus={(issue, status) =>
        useIssuesStore.getState().setIssueStatus(activeTracker, issue, status)
      }
      onSetPriority={(issue, level) =>
        useIssuesStore.getState().setIssuePriority(activeTracker, issue, level)
      }
      onOpenIssue={(issue) =>
        void useIssuesStore.getState().openIssue({
          tracker: activeTracker,
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          ...(issue.url ? { url: issue.url } : {}),
          seed: issue,
        })
      }
      onStartSession={handleStartSession}
      onConnect={onConnect}
      onSetQuery={(q) => useIssuesStore.getState().setQuery(q)}
      onTogglePriority={(level) => useIssuesStore.getState().togglePriority(level)}
      onToggleStatus={(name) => useIssuesStore.getState().toggleStatus(name)}
      onToggleAssignee={(value) => useIssuesStore.getState().toggleAssignee(value)}
      onClearFilters={() => useIssuesStore.getState().clearFilters()}
    />
  );
}
