import { useMemo } from "react";
import { IssuesViewer } from "./IssuesViewer.js";
import { IssueDetail } from "./IssueDetail.js";
import {
  distinctAssignees,
  distinctLabels,
  distinctStatuses,
  filterIssues,
  type AssigneeOption,
  type LabelOption,
  type StatusOption,
} from "./issues-filter.js";
import type { IssueStatusRef } from "./IssueFieldControls.js";
import { buildSections, collapsePredicate, type IssueSection } from "./issues-sort.js";
import { useIssuesStore } from "../stores/issues-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { useRepoStore } from "../stores/repo-store.js";
import type { IssueLabel, IssuePriorityLevel, TrackerId, TrackerIssue } from "../../server/shared/types.js";

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
const EMPTY_LABELS: LabelOption[] = [];
const EMPTY_STATUS_REFS: IssueStatusRef[] = [];
const EMPTY_AVAILABLE_LABELS: IssueLabel[] = [];
const EMPTY_SECTIONS: IssueSection[] = [];

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
  const availableLabels = useIssuesStore(
    (s) => s.labelsByTracker[s.activeTracker] ?? EMPTY_AVAILABLE_LABELS,
  );
  const loading = useIssuesStore((s) => s.loading);
  const error = useIssuesStore((s) => s.error);
  const filters = useIssuesStore((s) => s.filters);
  const includeDone = useIssuesStore((s) => s.includeDone);
  const sortPrefs = useIssuesStore((s) => s.sortPrefs);
  const collapseById = useIssuesStore((s) => s.collapseById);
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

  // Build the nested render plan (docs/206): sort + group + collapse applied to
  // the filtered set, client-side. Two variants — the wide (table) layout
  // defaults parents EXPANDED, the narrow (card) layout defaults them COLLAPSED
  // — and the viewer picks one by its measured width. Memoized so the viewer
  // re-renders only when an input actually changes.
  const desktopSections = useMemo(() => {
    if (filteredIssues.length === 0) return EMPTY_SECTIONS;
    return buildSections(filteredIssues, sortPrefs, collapsePredicate(collapseById, false));
  }, [filteredIssues, sortPrefs, collapseById]);

  const mobileSections = useMemo(() => {
    if (filteredIssues.length === 0) return EMPTY_SECTIONS;
    return buildSections(filteredIssues, sortPrefs, collapsePredicate(collapseById, true));
  }, [filteredIssues, sortPrefs, collapseById]);

  const statusOptions = useMemo(() => {
    const result = distinctStatuses(issues);
    return result.length === 0 ? EMPTY_STATUSES : result;
  }, [issues]);

  const assigneeOptions = useMemo(() => {
    const result = distinctAssignees(issues);
    return result.length === 0 ? EMPTY_ASSIGNEES : result;
  }, [issues]);

  const labelOptions = useMemo(() => {
    const result = distinctLabels(issues);
    return result.length === 0 ? EMPTY_LABELS : result;
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
  // inline detail view. Filter state lives in the store, so the filtered view
  // survives the round-trip; the list's scroll offset doesn't (the viewer
  // unmounts), so we stash/restore it via `listScrollTop` (wired below).
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
        {...(selected.anchorCommentId ? { anchorCommentId: selected.anchorCommentId } : {})}
        onAnchorConsumed={() => useIssuesStore.getState().clearAnchorComment()}
        availableStatuses={availableStatuses}
        availableLabels={availableLabels}
        canEditPriority={detailTracker === "linear"}
        canEditLabels
        onFetchLabels={() => void useIssuesStore.getState().fetchLabels(detailTracker)}
        onSetLabels={(names) => {
          const open = useIssuesStore.getState().detail;
          if (!open) return Promise.resolve("No issue is open");
          return useIssuesStore.getState().setIssueLabels(detailTracker, open, names);
        }}
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
      desktopSections={desktopSections}
      mobileSections={mobileSections}
      sortPrefs={sortPrefs}
      filters={filters}
      statusOptions={statusOptions}
      assigneeOptions={assigneeOptions}
      labelOptions={labelOptions}
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
      onSetSortPrefs={(prefs) => useIssuesStore.getState().setSortPrefs(prefs)}
      onSetCollapsed={(id, collapsed) => useIssuesStore.getState().setCollapsed(id, collapsed)}
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
      initialScrollTop={useIssuesStore.getState().listScrollTop}
      onPersistScroll={(top) => useIssuesStore.getState().setListScrollTop(top)}
      onStartSession={handleStartSession}
      onConnect={onConnect}
      onSetQuery={(q) => useIssuesStore.getState().setQuery(q)}
      onTogglePriority={(level) => useIssuesStore.getState().togglePriority(level)}
      onToggleStatus={(name) => useIssuesStore.getState().toggleStatus(name)}
      onToggleAssignee={(value) => useIssuesStore.getState().toggleAssignee(value)}
      onToggleLabel={(name) => useIssuesStore.getState().toggleLabel(name)}
      onClearFilters={() => useIssuesStore.getState().clearFilters()}
    />
  );
}
