import { useState } from "react";
import type { ConversationBranch } from "../../server/types.js";

export interface GitCommit {
  hash: string;
  message: string;
  date: string;
  author: string;
}

const BRANCH_COLORS = [
  "bg-blue-500",
  "bg-emerald-500",
  "bg-purple-500",
  "bg-amber-500",
  "bg-pink-500",
  "bg-cyan-500",
];

export function GitHistory({
  commits,
  onRollback,
  onRefresh,
  branches,
  activeBranchId,
  onBranchFromCheckpoint,
}: {
  commits: GitCommit[];
  onRollback: (hash: string) => void;
  onRefresh: () => void;
  branches?: ConversationBranch[];
  activeBranchId?: string;
  onBranchFromCheckpoint?: (checkpointId: string) => void;
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

  const checkpointCount = branches?.reduce((sum, branch) => sum + branch.checkpoints.length, 0) ?? 0;

  return (
    <div className="border-t border-gray-200 dark:border-gray-800">
      <button
        onClick={() => {
          setExpanded((v) => !v);
          if (!expanded) onRefresh();
        }}
        className="flex items-center justify-between w-full px-4 py-2 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100/50 dark:hover:bg-gray-800/50 transition-colors"
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
        <div className="max-h-72 overflow-y-auto px-4 pb-3 space-y-3">
          {branches && branches.length > 0 && (
            <div className="rounded border border-gray-200 dark:border-gray-700 p-2">
              <p className="text-[11px] text-gray-500 dark:text-gray-400 mb-1">Branch timeline ({checkpointCount} checkpoints)</p>
              <div className="space-y-1">
                {branches.map((branch, branchIdx) => {
                  const branchColor = BRANCH_COLORS[branchIdx % BRANCH_COLORS.length];
                  const isActive = branch.id === activeBranchId;
                  return (
                    <div key={branch.id} className="text-xs">
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`inline-block w-2 h-2 rounded-full ${branchColor}`} />
                        <span className={isActive ? "text-white" : "text-gray-300"}>{branch.name}</span>
                        {isActive && <span className="text-[10px] px-1 rounded bg-gray-700 text-gray-200">active</span>}
                      </div>
                      <div className="pl-4 space-y-1">
                        {branch.checkpoints.map((checkpoint) => (
                          <button
                            key={checkpoint.id}
                            onClick={() => onBranchFromCheckpoint?.(checkpoint.id)}
                            className="w-full text-left rounded px-2 py-1 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                          >
                            {checkpoint.label ? checkpoint.label : `message ${checkpoint.messageIndex}`}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

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
