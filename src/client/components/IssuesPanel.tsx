import { IssuesViewer } from "./IssuesViewer.js";
import { useIssuesStore } from "../stores/issues-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { useRepoStore } from "../stores/repo-store.js";
import type { TrackerId, TrackerIssue } from "../../server/shared/types.js";

/**
 * Stable empty-array reference. Returning a fresh `[]` literal from a Zustand
 * selector makes `useSyncExternalStore` see a new snapshot on every render,
 * which loops into React error #185 ("Maximum update depth exceeded") — exactly
 * the state on tab open, before the first fetch populates `issuesByTracker`.
 */
const EMPTY_ISSUES: TrackerIssue[] = [];

/**
 * Connected wrapper around {@link IssuesViewer} (docs/170). Resolves the repo
 * to start a session on (the current session's remote, falling back to the
 * active sidebar repo) to gate the Start-session action, and delegates the
 * action itself to the parent. "Start session" seeds the chat input with the
 * issue's context (it does NOT auto-send) — mirroring the docs "Start Session"
 * flow — so the actual prefill + fresh-session handling lives in App.tsx where
 * handleNewSessionForRepo is available. Kept separate so IssuesViewer stays a
 * pure presentational component (easy to render in tests).
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
  const loading = useIssuesStore((s) => s.loading);
  const error = useIssuesStore((s) => s.error);

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

  return (
    <IssuesViewer
      trackers={trackers}
      activeTracker={activeTracker}
      issues={issues}
      info={info}
      loading={loading}
      error={error}
      canStart={Boolean(effectiveRepoUrl)}
      onSelectTracker={handleSelectTracker}
      onRefresh={() => void useIssuesStore.getState().fetchIssues()}
      onStartSession={handleStartSession}
      onConnect={onConnect}
    />
  );
}
