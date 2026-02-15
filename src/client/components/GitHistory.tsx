import { useState } from "react";

export interface GitCommit {
  hash: string;
  message: string;
  date: string;
  author: string;
}

export function GitHistory({
  commits,
  onRollback,
  onRefresh,
}: {
  commits: GitCommit[];
  onRollback: (hash: string) => void;
  onRefresh: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  const handleRollback = (hash: string) => {
    if (confirming === hash) {
      onRollback(hash);
      setConfirming(null);
    } else {
      setConfirming(hash);
    }
  };

  return (
    <div className="border-t border-gray-800">
      <button
        onClick={() => {
          setExpanded((v) => !v);
          if (!expanded) onRefresh();
        }}
        className="flex items-center justify-between w-full px-4 py-2 text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-800/50 transition-colors"
      >
        <span className="flex items-center gap-2">
          <svg
            className={`w-3 h-3 transition-transform ${expanded ? "rotate-90" : ""}`}
            fill="currentColor"
            viewBox="0 0 20 20"
          >
            <path
              fillRule="evenodd"
              d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
              clipRule="evenodd"
            />
          </svg>
          Git History ({commits.length})
        </span>
      </button>

      {expanded && (
        <div className="max-h-60 overflow-y-auto px-4 pb-3">
          {commits.length === 0 ? (
            <p className="text-xs text-gray-500 py-2">No commits yet.</p>
          ) : (
            <div className="space-y-1">
              {commits.map((commit, i) => (
                <div
                  key={commit.hash}
                  className="flex items-start justify-between gap-2 rounded px-2 py-1.5 text-xs hover:bg-gray-800/50 group"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-gray-300 truncate">{commit.message}</p>
                    <p className="text-gray-600 font-mono">
                      {commit.hash.slice(0, 7)}{" "}
                      <span className="text-gray-600">
                        {formatRelativeDate(commit.date)}
                      </span>
                    </p>
                  </div>
                  {i > 0 && (
                    <button
                      onClick={() => handleRollback(commit.hash)}
                      onBlur={() => setConfirming(null)}
                      className={`shrink-0 px-2 py-0.5 rounded text-xs transition-colors ${
                        confirming === commit.hash
                          ? "bg-red-900 text-red-300"
                          : "bg-gray-800 text-gray-500 opacity-0 group-hover:opacity-100 hover:text-gray-300"
                      }`}
                    >
                      {confirming === commit.hash ? "confirm?" : "rollback"}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
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
