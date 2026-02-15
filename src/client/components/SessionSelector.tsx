import { useState, useRef, useEffect } from "react";

export interface SessionInfo {
  id: string;
  title: string;
  createdAt: string;
  lastUsedAt: string;
}

export function SessionSelector({
  sessions,
  currentSessionId,
  onResume,
  onNew,
  onDelete,
  onRename,
  onRefresh,
}: {
  sessions: SessionInfo[];
  currentSessionId: string | undefined;
  onResume: (sessionId: string) => void;
  onNew: () => void;
  onDelete: (sessionId: string) => void;
  onRename: (sessionId: string, title: string) => void;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  const startEditing = (session: SessionInfo) => {
    setEditingId(session.id);
    setEditTitle(session.title);
  };

  const submitRename = () => {
    if (editingId && editTitle.trim()) {
      onRename(editingId, editTitle.trim());
    }
    setEditingId(null);
    setEditTitle("");
  };

  const cancelEditing = () => {
    setEditingId(null);
    setEditTitle("");
  };

  return (
    <div className="relative">
      <button
        onClick={() => {
          setOpen((v) => !v);
          if (!open) onRefresh();
        }}
        className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-gray-100 transition-colors"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
        </svg>
        Sessions
        <svg
          className={`w-3 h-3 transition-transform ${open ? "rotate-180" : ""}`}
          fill="currentColor"
          viewBox="0 0 20 20"
        >
          <path
            fillRule="evenodd"
            d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {open && (
        <>
          {/* Backdrop to close dropdown */}
          <div className="fixed inset-0 z-40" onClick={() => { setOpen(false); cancelEditing(); }} />

          <div className="absolute top-full left-0 mt-1 w-72 bg-gray-900 border border-gray-700 rounded-lg shadow-xl z-50 overflow-hidden">
            {/* New session button */}
            <button
              onClick={() => {
                onNew();
                setOpen(false);
              }}
              className="flex items-center gap-2 w-full px-3 py-2.5 text-xs text-emerald-400 hover:bg-gray-800 transition-colors border-b border-gray-800"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              New Session
            </button>

            {/* Session list */}
            <div className="max-h-64 overflow-y-auto">
              {sessions.length === 0 ? (
                <p className="text-xs text-gray-500 px-3 py-4 text-center">No sessions yet. Start chatting to create one.</p>
              ) : (
                sessions.map((session) => {
                  const isCurrent = session.id === currentSessionId;
                  const isEditing = editingId === session.id;
                  return (
                    <div
                      key={session.id}
                      className={`group flex items-start gap-2 px-3 py-2 text-xs hover:bg-gray-800 transition-colors ${
                        isCurrent ? "bg-gray-800/60" : ""
                      }`}
                    >
                      {isEditing ? (
                        <form
                          className="flex-1 min-w-0"
                          onSubmit={(e) => { e.preventDefault(); submitRename(); }}
                        >
                          <input
                            ref={editInputRef}
                            type="text"
                            value={editTitle}
                            onChange={(e) => setEditTitle(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Escape") cancelEditing(); }}
                            onBlur={submitRename}
                            className="w-full bg-gray-800 text-gray-100 text-xs px-2 py-1 rounded border border-gray-600 focus:border-blue-500 focus:outline-none"
                            maxLength={120}
                          />
                        </form>
                      ) : (
                        <button
                          onClick={() => {
                            if (!isCurrent) onResume(session.id);
                            setOpen(false);
                          }}
                          className="flex-1 min-w-0 text-left"
                        >
                          <p className={`truncate ${isCurrent ? "text-emerald-300" : "text-gray-300"}`}>
                            {isCurrent && <span className="mr-1">&bull;</span>}
                            {session.title}
                          </p>
                          <p className="text-gray-600 mt-0.5">
                            {formatRelativeDate(session.lastUsedAt)}
                          </p>
                        </button>
                      )}
                      {!isEditing && (
                        <div className="shrink-0 flex items-center gap-0.5">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              startEditing(session);
                            }}
                            className="p-1 rounded text-gray-600 opacity-0 group-hover:opacity-100 hover:text-blue-400 hover:bg-gray-700 transition-all"
                            title="Rename session"
                          >
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487z" />
                            </svg>
                          </button>
                          {!isCurrent && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                onDelete(session.id);
                              }}
                              className="p-1 rounded text-gray-600 opacity-0 group-hover:opacity-100 hover:text-red-400 hover:bg-gray-700 transition-all"
                              title="Delete session"
                            >
                              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function formatRelativeDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}
