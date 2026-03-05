import { useState, useRef, useEffect, useMemo } from "react";
import { XIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { parseRepoLabel } from "../utils/repo-label.js";
import type { SessionInfo, RepoInfo } from "../../server/shared/types.js";
import { Button } from "./ui/button.js";
import { Modal } from "./ui/modal.js";
import { SessionItem } from "./SessionSidebar.js";

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

  const handleResume = async (sessionId: string) => {
    const session = sessions.find((s) => s.id === sessionId);
    if (session?.archived) {
      await onUnarchive(sessionId);
    }
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
            <XIcon size={ICON_SIZE.SM} />
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
              filtered.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  isCurrent={false}
                  onResume={handleResume}
                  onArchive={handleArchive}
                  onRestore={handleUnarchive}
                  repoLabel={selectedRepo === ALL_REPOS && session.remoteUrl ? parseRepoLabel(session.remoteUrl) : undefined}
                  disabled={actioningId === session.id}
                />
              ))
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
