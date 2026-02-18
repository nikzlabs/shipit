import { useState, useRef, useEffect, useCallback } from "react";
import { parseRepoLabel } from "../utils/repo-label.js";
import type { SessionInfo } from "../../server/types.js";

interface RepoResult {
  fullName: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  cloneUrl: string;
}

export interface RepoSelectorProps {
  sessions: SessionInfo[];
  searchResults: RepoResult[];
  onSearch: (query: string) => void;
  selectedRepoUrl: string | null;
  onSelect: (repoUrl: string) => void;
  onNewRepo: () => void;
  disabled: boolean;
}

export function RepoSelector({
  sessions,
  searchResults,
  onSearch,
  selectedRepoUrl,
  onSelect,
  onNewRepo,
  disabled,
}: RepoSelectorProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Deduplicate repos from sessions by remoteUrl
  const sessionRepos = Array.from(
    new Map(
      sessions
        .filter((s) => s.remoteUrl)
        .map((s) => [s.remoteUrl!, s.remoteUrl!]),
    ).values(),
  );

  // Filter session repos by query (client-side)
  const filteredSessionRepos = query.trim()
    ? sessionRepos.filter((url) =>
        parseRepoLabel(url).toLowerCase().includes(query.toLowerCase()),
      )
    : sessionRepos;

  // Debounced GitHub search
  const handleInputChange = useCallback(
    (value: string) => {
      setQuery(value);
      setOpen(true);

      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        const trimmed = value.trim();
        if (trimmed.length >= 2) {
          onSearch(trimmed);
        }
      }, 300);
    },
    [onSearch],
  );

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // Close on click outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const handleSelect = useCallback(
    (repoUrl: string) => {
      onSelect(repoUrl);
      setQuery("");
      setOpen(false);
    },
    [onSelect],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        inputRef.current?.blur();
      }
    },
    [],
  );

  const selectedLabel = selectedRepoUrl ? parseRepoLabel(selectedRepoUrl) : null;

  // Merge session repos and search results, avoiding duplicates
  const searchRepoUrls = new Set(filteredSessionRepos);
  const uniqueSearchResults = searchResults.filter(
    (r) => !searchRepoUrls.has(r.cloneUrl),
  );

  const hasResults = filteredSessionRepos.length > 0 || uniqueSearchResults.length > 0;

  return (
    <div ref={containerRef} className="relative w-full max-w-xl">
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={open ? query : selectedLabel ?? query}
          onChange={(e) => handleInputChange(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder="Select a repository..."
          disabled={disabled}
          className="w-full px-4 py-2.5 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 disabled:opacity-50"
        />
        {selectedRepoUrl && !open && (
          <button
            onClick={() => {
              onSelect("");
              setQuery("");
              inputRef.current?.focus();
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 text-lg leading-none"
            aria-label="Clear selection"
          >
            &times;
          </button>
        )}
      </div>

      {open && (
        <div className="absolute z-50 mt-1 w-full bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg shadow-xl max-h-64 overflow-y-auto">
          {/* New repo option */}
          <button
            onClick={() => {
              setOpen(false);
              onNewRepo();
            }}
            className="w-full text-left px-4 py-2.5 text-sm text-blue-600 dark:text-blue-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors flex items-center gap-2 border-b border-gray-300 dark:border-gray-700"
          >
            <span className="text-lg leading-none">+</span>
            <span>New repository</span>
          </button>

          {/* Session repos (local) */}
          {filteredSessionRepos.map((url) => (
            <button
              key={url}
              onClick={() => handleSelect(url)}
              className="w-full text-left px-4 py-2 text-sm text-gray-800 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            >
              {parseRepoLabel(url)}
            </button>
          ))}

          {/* GitHub search results */}
          {uniqueSearchResults.length > 0 && (
            <>
              {filteredSessionRepos.length > 0 && (
                <div className="border-t border-gray-300 dark:border-gray-700" />
              )}
              {uniqueSearchResults.map((repo) => (
                <button
                  key={repo.cloneUrl}
                  onClick={() => handleSelect(repo.cloneUrl)}
                  className="w-full text-left px-4 py-2 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-gray-800 dark:text-gray-200">{repo.fullName}</span>
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                        repo.private
                          ? "bg-yellow-100 dark:bg-yellow-900 text-yellow-700 dark:text-yellow-300"
                          : "bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300"
                      }`}
                    >
                      {repo.private ? "private" : "public"}
                    </span>
                  </div>
                  {repo.description && (
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate">
                      {repo.description}
                    </p>
                  )}
                </button>
              ))}
            </>
          )}

          {/* Empty state */}
          {!hasResults && query.trim().length > 0 && (
            <div className="px-4 py-3 text-xs text-gray-500">
              No repositories found
            </div>
          )}
        </div>
      )}
    </div>
  );
}
