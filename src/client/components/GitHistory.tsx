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
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200 dark:border-gray-800">
        <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
          {commits.length} {commits.length === 1 ? "commit" : "commits"}
        </span>
        <button
          onClick={onRefresh}
          className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
          aria-label="Refresh"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-2">
        {commits.length === 0 ? (
          <p className="text-xs text-gray-500 py-2">No commits yet.</p>
        ) : (
          <div className="space-y-1">
            {commits.map((commit, i) => (
              <div
                key={commit.hash}
                className="flex items-start justify-between gap-2 rounded px-2 py-1.5 text-xs hover:bg-gray-100/50 dark:hover:bg-gray-800/50 group"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-gray-700 dark:text-gray-300 truncate">{commit.message}</p>
                  <p className="text-gray-400 dark:text-gray-600 font-mono">
                    {commit.hash.slice(0, 7)}{" "}
                    <span className="text-gray-400 dark:text-gray-600">
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
                        ? "bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300"
                        : "bg-gray-100 dark:bg-gray-800 text-gray-500 opacity-0 group-hover:opacity-100 hover:text-gray-700 dark:hover:text-gray-300"
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
