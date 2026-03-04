import { useState, useRef, useEffect } from "react";
import { formatRelativeDate } from "../utils/dates.js";
import { parseRepoLabel } from "../utils/repo-label.js";
import type { SessionInfo } from "../../server/shared/types.js";

interface ArchivedSessionsDialogProps {
  open: boolean;
  onClose: () => void;
  sessions: SessionInfo[];
  onFetch: () => void;
  onUnarchive: (sessionId: string) => Promise<void>;
}

function RestoreIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" />
    </svg>
  );
}

export function ArchivedSessionsDialog({ open, onClose, sessions, onFetch, onUnarchive }: ArchivedSessionsDialogProps) {
  const [query, setQuery] = useState("");
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setRestoringId(null);
      onFetch();
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  if (!open) return null;

  const filtered = query.trim()
    ? sessions.filter((s) => {
        const q = query.toLowerCase();
        return (
          s.title.toLowerCase().includes(q) ||
          (s.remoteUrl && parseRepoLabel(s.remoteUrl).toLowerCase().includes(q))
        );
      })
    : sessions;

  const handleRestore = async (sessionId: string) => {
    setRestoringId(sessionId);
    try {
      await onUnarchive(sessionId);
    } finally {
      setRestoringId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-lg bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-300 dark:border-gray-700 px-4 py-3">
          <h2 className="text-sm font-medium text-gray-900 dark:text-gray-200">Archived Sessions</h2>
          <button
            onClick={onClose}
            className="text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
            aria-label="Close"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-4">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
            placeholder="Search archived sessions..."
            className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-500 focus:border-blue-500 focus:outline-none"
          />

          <div className="mt-2 max-h-80 overflow-y-auto rounded-md border border-gray-300 dark:border-gray-700">
            {filtered.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-gray-500 dark:text-gray-400">
                {sessions.length === 0 ? "No archived sessions." : "No matches found."}
              </p>
            ) : (
              filtered.map((session) => (
                <div
                  key={session.id}
                  className="flex items-start gap-2 px-3 py-2 border-b border-gray-200/50 dark:border-gray-700/50 last:border-b-0 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-gray-900 dark:text-gray-200 truncate">{session.title}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      {session.remoteUrl && (
                        <span className="text-[10px] text-gray-500 dark:text-gray-500 truncate">
                          {parseRepoLabel(session.remoteUrl)}
                        </span>
                      )}
                      <span className="text-[10px] text-gray-400 dark:text-gray-600">
                        {formatRelativeDate(session.lastUsedAt)}
                      </span>
                    </div>
                  </div>
                  <button
                    onClick={() => handleRestore(session.id)}
                    disabled={restoringId === session.id}
                    className="shrink-0 p-1 rounded text-gray-500 dark:text-gray-400 hover:text-emerald-500 dark:hover:text-emerald-400 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
                    title="Restore session"
                  >
                    <RestoreIcon />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

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
