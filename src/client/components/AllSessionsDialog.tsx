import { useState, useRef, useEffect, useMemo } from "react";
import { formatRelativeDate } from "../utils/dates.js";
import { parseRepoLabel } from "../utils/repo-label.js";
import type { SessionInfo, RepoInfo } from "../../server/shared/types.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Modal } from "./ui/modal.js";

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
    <Modal
      onClose={onClose}
      className="w-full max-w-lg rounded-lg border-(--color-border-secondary)"
    >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-(--color-border-secondary) px-4 py-3">
          <h2 className="text-sm font-medium text-(--color-text-primary)">
            All Sessions
          </h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
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
          </Button>
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
            className="flex-1 min-w-0 rounded-md border border-(--color-border-secondary) bg-(--color-bg-secondary) px-3 py-1.5 text-sm text-(--color-text-primary) placeholder-(--color-text-tertiary) focus:border-(--color-border-focus) focus:outline-none"
          />
          <select
            value={selectedRepo}
            onChange={(e) => setSelectedRepo(e.target.value)}
            className="shrink-0 max-w-[200px] rounded-md border border-(--color-border-secondary) bg-(--color-bg-secondary) px-2 py-1.5 text-sm text-(--color-text-primary) focus:border-(--color-border-focus) focus:outline-none truncate"
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
          <div className="max-h-80 overflow-y-auto rounded-md border border-(--color-border-secondary)">
            {filtered.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-(--color-text-secondary)">
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
                    className="group flex items-start gap-2 px-3 py-2 border-b border-(--color-border-primary)/50 last:border-b-0 hover:bg-(--color-bg-hover) transition-colors"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        {isArchived ? (
                          <button
                            onClick={() => handleResume(session.id)}
                            className="text-sm text-(--color-text-secondary) truncate hover:text-(--color-text-primary) transition-colors text-left"
                          >
                            {session.title}
                          </button>
                        ) : (
                          <button
                            onClick={() => handleResume(session.id)}
                            className="text-sm text-(--color-text-primary) truncate hover:text-(--color-text-link) transition-colors text-left"
                          >
                            {session.title}
                          </button>
                        )}
                        <Badge variant={isArchived ? "default" : "success"} className="shrink-0 text-[10px]">
                          {isArchived ? "Archived" : "Active"}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        {selectedRepo === ALL_REPOS && session.remoteUrl && (
                          <span className="text-[10px] text-(--color-text-tertiary) truncate">
                            {parseRepoLabel(session.remoteUrl)}
                          </span>
                        )}
                        <span className="text-[10px] text-(--color-text-tertiary)">
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
                          className="p-1 rounded text-(--color-text-secondary) hover:text-(--color-success) hover:bg-(--color-bg-hover) transition-colors disabled:opacity-50"
                          title="Restore session"
                        >
                          <RestoreIcon />
                        </button>
                      ) : (
                        <button
                          onClick={() => handleArchive(session.id)}
                          disabled={actioningId === session.id}
                          className="p-1 rounded text-(--color-text-secondary) hover:text-(--color-warning) hover:bg-(--color-bg-hover) transition-colors disabled:opacity-50"
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
        <div className="flex justify-end border-t border-(--color-border-secondary) px-4 py-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
          >
            Close
          </Button>
        </div>
    </Modal>
  );
}
