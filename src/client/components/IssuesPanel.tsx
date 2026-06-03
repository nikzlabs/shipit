import { useNavigate } from "react-router-dom";
import { IssuesViewer } from "./IssuesViewer.js";
import { useIssuesStore } from "../stores/issues-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { useRepoStore } from "../stores/repo-store.js";
import type { TrackerId, TrackerIssue } from "../../server/shared/types.js";

/**
 * Connected wrapper around {@link IssuesViewer} (docs/170). Resolves the repo
 * to start a session on (the current session's remote, falling back to the
 * active sidebar repo), wires the store actions, and navigates to the new
 * session when "Start session" succeeds. Kept separate so IssuesViewer stays a
 * pure presentational component (easy to render in tests).
 */
export function IssuesPanel({ onConnect }: { onConnect: () => void }) {
  const navigate = useNavigate();
  const trackers = useIssuesStore((s) => s.trackers);
  const activeTracker = useIssuesStore((s) => s.activeTracker);
  const issues = useIssuesStore((s) => s.issuesByTracker[s.activeTracker] ?? []);
  const info = useIssuesStore((s) => s.infoByTracker[s.activeTracker]);
  const loading = useIssuesStore((s) => s.loading);
  const error = useIssuesStore((s) => s.error);
  const startingIds = useIssuesStore((s) => s.startingIds);

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

  const handleStartSession = async (issue: TrackerIssue) => {
    if (!effectiveRepoUrl) return;
    const sessionId = await useIssuesStore.getState().startSession(issue, effectiveRepoUrl);
    if (sessionId) void navigate(`/session/${sessionId}`);
  };

  return (
    <IssuesViewer
      trackers={trackers}
      activeTracker={activeTracker}
      issues={issues}
      info={info}
      loading={loading}
      error={error}
      startingIds={startingIds}
      canStart={Boolean(effectiveRepoUrl)}
      onSelectTracker={handleSelectTracker}
      onRefresh={() => void useIssuesStore.getState().fetchIssues()}
      onStartSession={handleStartSession}
      onConnect={onConnect}
    />
  );
}
