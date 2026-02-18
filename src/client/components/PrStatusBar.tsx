import { useState, useCallback } from "react";

export interface PrStatusBarProps {
  baseBranch: string;
  headBranch: string;
  insertions: number;
  deletions: number;
  prUrl: string;
  prNumber: number;
  checks: {
    state: "pending" | "success" | "failure" | "none";
    total: number;
    passed: number;
    failed: number;
    pending: number;
  };
  autoMergeEnabled: boolean;
  mergeable: boolean;
  onMerge: (method: "merge" | "squash" | "rebase") => void;
}

export function PrStatusBar({
  baseBranch,
  headBranch,
  insertions,
  deletions,
  prUrl,
  checks,
  autoMergeEnabled,
  mergeable,
  onMerge,
}: PrStatusBarProps) {
  const [copied, setCopied] = useState(false);
  const [mergeMethod, setMergeMethod] = useState<"merge" | "squash" | "rebase">("merge");
  const [showDropdown, setShowDropdown] = useState(false);

  const copyBranch = useCallback(() => {
    navigator.clipboard.writeText(headBranch);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [headBranch]);

  const mergeDisabled = checks.state === "failure" || !mergeable;

  return (
    <div className="flex items-center gap-3 px-3 py-1.5 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 text-xs">
      {/* Git merge icon */}
      <svg className="w-4 h-4 text-gray-500 dark:text-gray-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
      </svg>

      {/* Branch flow */}
      <span className="text-gray-500 dark:text-gray-400 truncate">
        <span className="text-gray-700 dark:text-gray-300 font-medium">{baseBranch}</span>
        {" \u2190 "}
        <span className="text-blue-400 font-medium">{headBranch}</span>
      </span>

      {/* Copy branch name */}
      <button
        onClick={copyBranch}
        className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors shrink-0"
        title="Copy branch name"
        aria-label="Copy branch name"
      >
        {copied ? "\u2713" : "\ud83d\udccb"}
      </button>

      {/* Diff stats */}
      <span className="flex items-center gap-1.5 text-xs shrink-0">
        <span className="text-green-400">+{insertions}</span>
        <span className="text-red-400">-{deletions}</span>
      </span>

      {/* CI status indicator */}
      {checks.state !== "none" && (
        <span
          className="flex items-center gap-1 shrink-0"
          title={`${checks.passed}/${checks.total} checks passed`}
        >
          {checks.state === "success" && (
            <span className="text-green-400">{"\u2713"} CI passed</span>
          )}
          {checks.state === "pending" && (
            <span className="text-yellow-400 animate-pulse">
              {"\u23f3"} CI running ({checks.passed}/{checks.total})
            </span>
          )}
          {checks.state === "failure" && (
            <span className="text-red-400">
              {"\u2717"} CI failed ({checks.failed} failed)
            </span>
          )}
        </span>
      )}

      <div className="ml-auto flex items-center gap-2 shrink-0">
        {/* View PR */}
        <a
          href={prUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="px-2.5 py-1 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-800 dark:text-gray-200 rounded text-xs font-medium transition-colors"
        >
          View PR
        </a>

        {/* Merge button with dropdown */}
        <div className="relative">
          <div className="flex">
            <button
              onClick={() => onMerge(mergeMethod)}
              disabled={mergeDisabled}
              className={`px-2.5 py-1 rounded-l text-xs font-medium transition-colors ${
                mergeDisabled
                  ? "bg-gray-100 dark:bg-gray-800 text-gray-500 cursor-not-allowed"
                  : autoMergeEnabled
                    ? "bg-yellow-600 hover:bg-yellow-500 text-white"
                    : "bg-green-600 hover:bg-green-500 text-white"
              }`}
              title={
                mergeDisabled
                  ? checks.state === "failure"
                    ? "CI checks failed"
                    : "PR has merge conflicts"
                  : autoMergeEnabled
                    ? "Auto-merge enabled"
                    : checks.state === "pending"
                      ? "Merge (when CI passes)"
                      : "Merge"
              }
            >
              {autoMergeEnabled
                ? "Auto-merge \u2713"
                : mergeDisabled
                  ? "Merge \u2298"
                  : "Merge"}
            </button>
            <button
              onClick={() => setShowDropdown(!showDropdown)}
              disabled={mergeDisabled}
              className={`px-1.5 py-1 rounded-r border-l border-black/20 text-xs ${
                mergeDisabled
                  ? "bg-gray-100 dark:bg-gray-800 text-gray-500 cursor-not-allowed"
                  : autoMergeEnabled
                    ? "bg-yellow-600 hover:bg-yellow-500 text-white"
                    : "bg-green-600 hover:bg-green-500 text-white"
              }`}
              aria-label="Merge method"
            >
              {"\u25bc"}
            </button>
          </div>

          {/* Merge method dropdown */}
          {showDropdown && (
            <div className="absolute right-0 top-full mt-1 bg-white dark:bg-gray-800 rounded shadow-lg border border-gray-300 dark:border-gray-700 py-1 z-50">
              {(["merge", "squash", "rebase"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => {
                    setMergeMethod(m);
                    setShowDropdown(false);
                  }}
                  className={`block w-full text-left px-3 py-1.5 text-xs hover:bg-gray-200 dark:hover:bg-gray-700 whitespace-nowrap ${
                    mergeMethod === m
                      ? "text-gray-900 dark:text-white font-medium"
                      : "text-gray-700 dark:text-gray-300"
                  }`}
                >
                  {m === "merge"
                    ? "Merge commit"
                    : m === "squash"
                      ? "Squash and merge"
                      : "Rebase and merge"}
                  {mergeMethod === m && " \u2713"}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
