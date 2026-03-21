import { ArrowsClockwiseIcon } from "@phosphor-icons/react";
import { Button } from "./ui/button.js";

export interface GitCommit {
  hash: string;
  message: string;
  date: string;
  author: string;
}

export function GitHistory({
  commits,
  onRefresh,
  onViewDiff,
}: {
  commits: GitCommit[];
  onRefresh: () => void;
  onViewDiff?: (commitHash: string, parentHash: string | null) => void;
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-2 border-b border-(--color-border-primary)">
        <span className="text-xs font-medium text-(--color-text-secondary)">
          {commits.length} {commits.length === 1 ? "commit" : "commits"}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          className="text-(--color-text-tertiary)"
          aria-label="Refresh"
        >
          <ArrowsClockwiseIcon size={14} />
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-2">
        {commits.length === 0 ? (
          <p className="text-xs text-(--color-text-secondary) py-2">No commits yet.</p>
        ) : (
          <div className="space-y-1">
            {commits.map((commit, i) => (
              <div
                key={commit.hash}
                className={`flex items-start gap-2 rounded px-2 py-1.5 text-xs hover:bg-(--color-bg-hover) ${onViewDiff ? "cursor-pointer" : ""}`}
                onClick={() => onViewDiff?.(commit.hash, commits[i + 1]?.hash ?? null)}
              >
                <div className="min-w-0 flex-1">
                  <p className="text-(--color-text-primary) truncate">{commit.message}</p>
                  <p className="text-(--color-text-tertiary) font-mono">
                    {commit.hash.slice(0, 7)}{" "}
                    <span className="text-(--color-text-tertiary)">
                      {formatRelativeDate(commit.date)}
                    </span>
                  </p>
                </div>
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
