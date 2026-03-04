import { useState, useRef, useEffect, useMemo } from "react";
import { formatRelativeDate } from "../utils/dates.js";
import { parseRepoLabel } from "../utils/repo-label.js";
import type { SessionInfo, RepoInfo } from "../../server/shared/types.js";

interface AllSessionsDialogProps {
  open: boolean;
  onClose: () => void;
  sessions: SessionInfo[];
  repos: RepoInfo[];
  currentRepoUrl: string | undefined;
  onFetch: () => void;
  onResume: (sessionId: string) => void;
  onUnarchive: (sessionId: string) => Promise<void>;
  onArchive: (sessionId: string) => Promise<void>;
}

const ALL_REPOS = "__all__";

function RestoreIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" />
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

export function AllSessionsDialog({
  open,
  onClose,
  sessions,
  repos,
  currentRepoUrl,
  onFetch,
  onResume,
  onUnarchive,
  onArchive,
}: AllSessionsDialogProps) {
  const [query, setQuery] = useState("");
  const [selectedRepo, setSelectedRepo] = useState<string>(ALL_REPOS);
  const [actioningId, setActioningId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Build unique repo URLs from all sessions + repos list
  const repoOptions = useMemo(() => {
    const urls = new Set<string>();
    for (const s of sessions) {
      if (s.remoteUrl) urls.add(s.remoteUrl);
    }
    for (const r of repos) {
      urls.add(r.url);
    }
    return [...urls].sort((a, b) =>
      parseRepoLabel(a).localeCompare(parseRepoLabel(b)),
    );
  }, [sessions, repos]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedRepo(currentRepoUrl ?? ALL_REPOS);
      setActioningId(null);
      onFetch();
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  if (!open) return null;

  const filtered = sessions.filter((s) => {
    // Repo filter
    if (selectedRepo !== ALL_REPOS && s.remoteUrl !== selectedRepo) return false;
    // Text filter
    if (query.trim()) {
      const q = query.toLowerCase();
      const matchesTitle = s.title.toLowerCase().includes(q);
      const matchesRepo =
        s.remoteUrl && parseRepoLabel(s.remoteUrl).toLowerCase().includes(q);
      if (!matchesTitle && !matchesRepo) return false;
    }
    return true;
  });

  const handleUnarchive = async (sessionId: string) => {
    setActioningId(sessionId);
    try {
      await onUnarchive(sessionId);
    } finally {
      setActioningId(null);
    }
  };

  const handleArchive = async (sessionId: string) => {
    setActioningId(sessionId);
    try {
      await onArchive(sessionId);
    } finally {
      setActioningId(null);
    }
  };

  const handleResume = (sessionId: string) => {
    onResume(sessionId);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-lg bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-300 dark:border-gray-700 px-4 py-3">
          <h2 className="text-sm font-medium text-gray-900 dark:text-gray-200">
            All Sessions
          </h2>
          <button
            onClick={onClose}
            className="text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
            aria-label="Close"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {/* Filter bar */}
        <div className="px-4 pt-3 pb-2 flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
            }}
            placeholder="Search sessions..."
            className="flex-1 min-w-0 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm text-gray-900 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-500 focus:border-blue-500 focus:outline-none"
          />
          <select
            value={selectedRepo}
            onChange={(e) => setSelectedRepo(e.target.value)}
            className="shrink-0 max-w-[200px] rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1.5 text-sm text-gray-900 dark:text-gray-200 focus:border-blue-500 focus:outline-none truncate"
          >
            <option value={ALL_REPOS}>All Repositories</option>
            {repoOptions.map((url) => (
              <option key={url} value={url}>
                {parseRepoLabel(url)}
              </option>
            ))}
          </select>
        </div>

        {/* Session list */}
        <div className="px-4 pb-3">
          <div className="max-h-80 overflow-y-auto rounded-md border border-gray-300 dark:border-gray-700">
            {filtered.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-gray-500 dark:text-gray-400">
                {sessions.length === 0
                  ? "No sessions yet."
                  : "No matches found."}
              </p>
            ) : (
              filtered.map((session) => {
                const isArchived = session.archived === true;
                return (
                  <div
                    key={session.id}
                    className="group flex items-start gap-2 px-3 py-2 border-b border-gray-200/50 dark:border-gray-700/50 last:border-b-0 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        {isArchived ? (
                          <button
                            onClick={() => handleResume(session.id)}
                            className="text-sm text-gray-500 dark:text-gray-400 truncate hover:text-gray-700 dark:hover:text-gray-200 transition-colors text-left"
                          >
                            {session.title}
                          </button>
                        ) : (
                          <button
                            onClick={() => handleResume(session.id)}
                            className="text-sm text-gray-900 dark:text-gray-200 truncate hover:text-blue-600 dark:hover:text-blue-400 transition-colors text-left"
                          >
                            {session.title}
                          </button>
                        )}
                        <span
                          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                            isArchived
                              ? "bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-500"
                              : "bg-emerald-100/50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400"
                          }`}
                        >
                          {isArchived ? "Archived" : "Active"}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        {selectedRepo === ALL_REPOS && session.remoteUrl && (
                          <span className="text-[10px] text-gray-500 dark:text-gray-500 truncate">
                            {parseRepoLabel(session.remoteUrl)}
                          </span>
                        )}
                        <span className="text-[10px] text-gray-400 dark:text-gray-600">
                          {formatRelativeDate(session.lastUsedAt)}
                        </span>
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      {isArchived ? (
                        <button
                          onClick={() => handleUnarchive(session.id)}
                          disabled={actioningId === session.id}
                          className="p-1 rounded text-gray-500 dark:text-gray-400 hover:text-emerald-500 dark:hover:text-emerald-400 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
                          title="Restore session"
                        >
                          <RestoreIcon />
                        </button>
                      ) : (
                        <button
                          onClick={() => handleArchive(session.id)}
                          disabled={actioningId === session.id}
                          className="p-1 rounded text-gray-500 dark:text-gray-400 hover:text-yellow-500 dark:hover:text-yellow-400 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
                          title="Archive session"
                        >
                          <ArchiveIcon />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end border-t border-gray-300 dark:border-gray-700 px-4 py-3">
          <button
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
