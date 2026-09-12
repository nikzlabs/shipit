import { useMemo } from "react";
import { isLinearTracker } from "../../server/shared/tracker-id.js";
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

// Zustand selectors require stable empty references to avoid React error #185.
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

export function IssuesPanel({
  onStartSession,
  onConnect,
}: {
  onStartSession: (issue: TrackerIssue, tracker: TrackerId, repoUrl?: string) => void;
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

  const filteredIssues = useMemo(() => {
    const result = filterIssues(issues, filters);
    return result.length === 0 ? EMPTY_ISSUES : result;
  }, [issues, filters]);

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

  const repoUrl = useSessionStore((s) => {
    const current = s.sessions.find((sess) => sess.id === s.sessionId);
    return current?.remoteUrl;
  });
  const activeRepoUrl = useRepoStore((s) => s.activeRepoUrl);
  const allRepos = useRepoStore((s) => s.repos);
  const effectiveRepoUrl = repoUrl || activeRepoUrl;

  const pickerRepos = useMemo(
    () => allRepos.filter((r) => !r.hidden || r.url === effectiveRepoUrl),
    [allRepos, effectiveRepoUrl],
  );

  const handleSelectTracker = (id: TrackerId) => {
    useIssuesStore.getState().setActiveTracker(id);
    void useIssuesStore.getState().fetchIssues(id);
  };

  const handleStartSession = (issue: TrackerIssue, targetRepoUrl?: string) => {
    if (!targetRepoUrl && !effectiveRepoUrl) return;
    onStartSession(issue, selected?.tracker ?? activeTracker, targetRepoUrl);
  };

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
        repos={pickerRepos}
        {...(effectiveRepoUrl ? { targetRepoUrl: effectiveRepoUrl } : {})}
        comments={comments}
        commentsLoading={commentsLoading}
        commentsError={commentsError}
        {...(selected.anchorCommentId ? { anchorCommentId: selected.anchorCommentId } : {})}
        onAnchorConsumed={() => useIssuesStore.getState().clearAnchorComment()}
        availableStatuses={availableStatuses}
        availableLabels={availableLabels}
        canEditPriority={isLinearTracker(detailTracker)}
        canEditLabels
        onFetchLabels={() => void useIssuesStore.getState().fetchLabels(detailTracker)}
        onSetLabels={(names) => {
          const open = useIssuesStore.getState().detail;
          if (!open) return Promise.resolve("No issue is open");
          return useIssuesStore.getState().setIssueLabels(detailTracker, open, names);
        }}
        onBack={() => useIssuesStore.getState().closeIssue()}
        onRefresh={() => {
          void useIssuesStore.getState().fetchDetail();
          void useIssuesStore.getState().fetchComments();
        }}
        onStartSession={handleStartSession}
        onPostComment={(body) => useIssuesStore.getState().postComment(body)}
        onSetStatus={(status) => {
          // A refetch can replace the issue between render and selection.
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
      repos={pickerRepos}
      {...(effectiveRepoUrl ? { targetRepoUrl: effectiveRepoUrl } : {})}
      includeDone={includeDone}
      availableStatuses={availableStatuses}
      canEditPriority={isLinearTracker(activeTracker)}
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
