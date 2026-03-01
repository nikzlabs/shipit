import { useState, useRef, useEffect } from "react";
import { formatRelativeDate } from "../utils/dates.js";
import { parseRepoLabel } from "../utils/repo-label.js";
import type { SessionInfo, RepoInfo } from "../../server/shared/types.js";

export type { SessionInfo };

interface SessionSidebarProps {
  sessions: SessionInfo[];
  repos: RepoInfo[];
  currentSessionId: string | undefined;
  activeRunnerSessions?: Set<string>;
  newSessionRepoUrl?: string;
  onResume: (sessionId: string) => void;
  onNew: () => void;
  onNewSessionForRepo: (repoUrl: string) => void;
  onArchive: (sessionId: string) => void;
  onRename: (sessionId: string, title: string) => void;
  onRefresh: () => void;
  onAddRepo: () => void;
  onRemoveRepo: (url: string) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={`w-3 h-3 shrink-0 text-gray-500 transition-transform ${expanded ? "rotate-90" : ""}`}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487z" />
    </svg>
  );
}

function ArchiveIcon() {
  return (
    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="m20.25 7.5-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" />
    </svg>
  );
}

interface SessionItemProps {
  session: SessionInfo;
  isCurrent: boolean;
  isRunning?: boolean;
  onResume: (id: string) => void;
  onArchive: (id: string) => void;
  onRename: (id: string, title: string) => void;
}

function SessionItem({ session, isCurrent, isRunning, onResume, onArchive, onRename }: SessionItemProps) {
  const [editingTitle, setEditingTitle] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const editResolvedRef = useRef(false);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      editResolvedRef.current = false;
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const startEditing = () => {
    setEditingTitle(session.title);
    setIsEditing(true);
  };

  const submitRename = () => {
    if (editResolvedRef.current) return;
    editResolvedRef.current = true;
    if (editingTitle.trim()) {
      onRename(session.id, editingTitle.trim());
    }
    setIsEditing(false);
    setEditingTitle("");
  };

  const cancelEditing = () => {
    editResolvedRef.current = true;
    setIsEditing(false);
    setEditingTitle("");
  };

  return (
    <div
      className={`group flex items-start gap-1.5 px-2 py-1.5 text-xs transition-colors rounded mx-1 ${
        isCurrent
          ? "bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100"
          : "text-gray-600 dark:text-gray-400 hover:bg-gray-100/60 dark:hover:bg-gray-800/60 hover:text-gray-800 dark:hover:text-gray-200"
      }`}
    >
      {/* Active / running indicator */}
      <span className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${
        isRunning && !isCurrent ? "bg-amber-400 animate-pulse" :
        isRunning && isCurrent ? "bg-emerald-400 animate-pulse" :
        isCurrent ? "bg-emerald-400" : "bg-transparent"
      }`} />

      {isEditing ? (
        <form
          className="flex-1 min-w-0"
          onSubmit={(e) => { e.preventDefault(); submitRename(); }}
        >
          <input
            ref={inputRef}
            type="text"
            value={editingTitle}
            onChange={(e) => setEditingTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") cancelEditing(); }}
            onBlur={submitRename}
            className="w-full bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-xs px-1.5 py-0.5 rounded border border-gray-300 dark:border-gray-600 focus:border-blue-500 focus:outline-none"
            maxLength={120}
          />
        </form>
      ) : (
        <button
          onClick={() => { if (!isCurrent) onResume(session.id); }}
          className="flex-1 min-w-0 text-left"
        >
          <p className="truncate leading-snug">{session.title}</p>
          <p className="text-gray-500 dark:text-gray-600 text-[10px] mt-0.5">{formatRelativeDate(session.lastUsedAt)}</p>
        </button>
      )}

      {!isEditing && (
        <div className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={(e) => { e.stopPropagation(); startEditing(); }}
            className="p-0.5 rounded text-gray-500 dark:text-gray-600 hover:text-blue-400 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
            title="Rename session"
          >
            <PencilIcon />
          </button>
          {!isCurrent && (
            <button
              onClick={(e) => { e.stopPropagation(); onArchive(session.id); }}
              className="p-0.5 rounded text-gray-500 dark:text-gray-600 hover:text-yellow-400 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
              title="Archive session"
            >
              <ArchiveIcon />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

interface GroupProps {
  label: string;
  sessions: SessionInfo[];
  currentSessionId: string | undefined;
  activeRunnerSessions?: Set<string>;
  isNewSessionActive?: boolean;
  onResume: (id: string) => void;
  onArchive: (id: string) => void;
  onRename: (id: string, title: string) => void;
  status?: "cloning" | "ready";
  onNewSession?: () => void;
  onRemove?: () => void;
}

function SessionGroup({ label, sessions, currentSessionId, activeRunnerSessions, isNewSessionActive, onResume, onArchive, onRename, status, onNewSession, onRemove }: GroupProps) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div>
      <div className="group/header flex items-center gap-1 w-full px-2 py-1">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1 flex-1 min-w-0 text-[10px] font-semibold text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 uppercase tracking-wide transition-colors"
        >
          <ChevronIcon expanded={expanded} />
          <span className="truncate flex-1 text-left">{label}</span>
          {status === "cloning" && (
            <span className="shrink-0 text-[9px] font-normal normal-case text-amber-400 animate-pulse">cloning</span>
          )}
          {sessions.length > 0 && (
            <span className="text-gray-400 dark:text-gray-700 font-normal normal-case">({sessions.length})</span>
          )}
        </button>
        {onRemove && (
          <button
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            className="shrink-0 p-0.5 rounded text-gray-500 dark:text-gray-700 opacity-0 group-hover/header:opacity-100 hover:text-red-400 hover:bg-gray-200 dark:hover:bg-gray-800 transition-all"
            title="Remove repository"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
      {expanded && (
        <div>
          {onNewSession && (
            <button
              onClick={onNewSession}
              disabled={status === "cloning"}
              className={`flex items-center gap-2 w-full px-2.5 py-1.5 mx-1 text-xs rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                isNewSessionActive
                  ? "bg-gray-100 dark:bg-gray-800 text-emerald-600 dark:text-emerald-400"
                  : "text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-300 hover:bg-gray-100 dark:hover:bg-gray-800"
              }`}
              style={{ width: "calc(100% - 0.5rem)" }}
            >
              <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              New Session
            </button>
          )}
          {sessions.map((s) => (
            <SessionItem
              key={s.id}
              session={s}
              isCurrent={s.id === currentSessionId}
              isRunning={activeRunnerSessions?.has(s.id)}
              onResume={onResume}
              onArchive={onArchive}
              onRename={onRename}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function SessionSidebar({
  sessions,
  repos,
  currentSessionId,
  activeRunnerSessions,
  newSessionRepoUrl,
  onResume,
  onNew: _onNew,
  onNewSessionForRepo,
  onArchive,
  onRename,
  onRefresh: _onRefresh,
  onAddRepo,
  onRemoveRepo,
  collapsed,
  onToggleCollapse,
}: SessionSidebarProps) {
  // Build repo groups: repos drive the structure, sessions are grouped within
  const repoUrls = new Set(repos.map((r) => r.url));
  const repoGroups = new Map<string, SessionInfo[]>();
  const noRemoteSessions: SessionInfo[] = [];

  for (const session of sessions) {
    if (session.remoteUrl && repoUrls.has(session.remoteUrl)) {
      const arr = repoGroups.get(session.remoteUrl) ?? [];
      arr.push(session);
      repoGroups.set(session.remoteUrl, arr);
    } else if (session.remoteUrl) {
      // Session has a remote but repo was removed — show under the URL still
      const arr = repoGroups.get(session.remoteUrl) ?? [];
      arr.push(session);
      repoGroups.set(session.remoteUrl, arr);
    } else {
      noRemoteSessions.push(session);
    }
  }

  // Ensure all repos have an entry even if they have no sessions yet
  for (const repo of repos) {
    if (!repoGroups.has(repo.url)) {
      repoGroups.set(repo.url, []);
    }
  }

  // Sort: repos sorted by lastUsedAt desc, then "No Remote" last
  const sortedRepoEntries = [...repoGroups.entries()].sort(([a], [b]) => {
    const repoA = repos.find((r) => r.url === a);
    const repoB = repos.find((r) => r.url === b);
    const dateA = repoA ? new Date(repoA.lastUsedAt).getTime() : 0;
    const dateB = repoB ? new Date(repoB.lastUsedAt).getTime() : 0;
    return dateB - dateA;
  });

  if (collapsed) {
    return (
      <div className="flex flex-col w-10 shrink-0 bg-white dark:bg-gray-950 border-r border-gray-200 dark:border-gray-800 items-center py-2 gap-2">
        <button
          onClick={onToggleCollapse}
          className="p-1.5 rounded text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          title="Expand sidebar"
          aria-label="Expand sidebar"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
          </svg>
        </button>
        <button
          onClick={onAddRepo}
          className="p-1.5 rounded text-blue-500 dark:text-blue-400 hover:text-blue-600 dark:hover:text-blue-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          title="Add Repository"
          aria-label="Add Repository"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 10.5v6m3-3H9m4.06-7.19l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col w-60 shrink-0 bg-white dark:bg-gray-950 border-r border-gray-200 dark:border-gray-800 min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-gray-200 dark:border-gray-800 shrink-0">
        <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Sessions</span>
        <button
          onClick={onToggleCollapse}
          className="p-1 rounded text-gray-500 dark:text-gray-600 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          title="Collapse sidebar"
          aria-label="Collapse sidebar"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
        </button>
      </div>

      {/* Add Repository button */}
      <div className="px-2 py-2 shrink-0">
        <button
          onClick={onAddRepo}
          className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs text-blue-500 dark:text-blue-400 hover:text-blue-600 dark:hover:text-blue-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded transition-colors"
        >
          <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 10.5v6m3-3H9m4.06-7.19l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
          </svg>
          Add Repository
        </button>
      </div>

      {/* Repo groups + ungrouped sessions */}
      <div className="flex-1 overflow-y-auto pb-2">
        {sessions.length === 0 && repos.length === 0 ? (
          <p className="text-xs text-gray-500 dark:text-gray-600 px-3 py-4 text-center">No sessions yet.</p>
        ) : (
          <>
            {sortedRepoEntries.map(([url, groupSessions]) => {
              const repo = repos.find((r) => r.url === url);
              return (
                <SessionGroup
                  key={url}
                  label={parseRepoLabel(url)}
                  sessions={groupSessions}
                  currentSessionId={currentSessionId}
                  activeRunnerSessions={activeRunnerSessions}
                  isNewSessionActive={newSessionRepoUrl === url}
                  onResume={onResume}
                  onArchive={onArchive}
                  onRename={onRename}
                  status={repo?.status}
                  onNewSession={() => onNewSessionForRepo(url)}
                  onRemove={() => onRemoveRepo(url)}
                />
              );
            })}
            {noRemoteSessions.length > 0 && (
              <SessionGroup
                label="No Remote"
                sessions={noRemoteSessions}
                currentSessionId={currentSessionId}
                activeRunnerSessions={activeRunnerSessions}
                onResume={onResume}
                onArchive={onArchive}
                onRename={onRename}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
