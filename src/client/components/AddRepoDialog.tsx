import { useState, useRef, useEffect } from "react";
import type { RepoInfo } from "../../server/shared/types.js";

interface AddRepoDialogProps {
  open: boolean;
  onClose: () => void;
  onAdd: (url: string) => Promise<void>;
  onCreateNew: () => void;
  /** Called when a newly-added repo finishes cloning and is ready. */
  onRepoReady?: (url: string) => void;
  searchResults: Array<{ fullName: string; description: string | null; private: boolean; cloneUrl: string }>;
  onSearch: (query: string) => void | Promise<void>;
  /** Current repos from the store — used to track clone progress. */
  repos: RepoInfo[];
}

export function AddRepoDialog({ open, onClose, onAdd, onCreateNew, onRepoReady, searchResults, onSearch, repos }: AddRepoDialogProps) {
  const [query, setQuery] = useState("");
  const [submitting, setSubmitting] = useState(false);
  /** URL of the repo we just added — tracked for clone progress. */
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  /** True while the initial GitHub repos list is being fetched. */
  const [loadingRepos, setLoadingRepos] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (open) {
      setQuery("");
      setPendingUrl(null);
      setTimeout(() => inputRef.current?.focus(), 50);
      // Lazy-load the user's GitHub repos on first open
      if (searchResults.length === 0) {
        setLoadingRepos(true);
        // eslint-disable-next-line no-restricted-syntax -- Promise two-arg form for loading state
        Promise.resolve(onSearch("")).then(
          () => setLoadingRepos(false),
          () => setLoadingRepos(false),
        );
      }
    }
  }, [open]);

  // Auto-close and navigate when the pending repo becomes ready
  const pendingRepo = pendingUrl ? repos.find((r) => r.url === pendingUrl) : null;
  useEffect(() => {
    if (pendingRepo?.status === "ready" && pendingUrl) {
      const url = pendingUrl;
      setPendingUrl(null);
      onClose();
      onRepoReady?.(url);
    }
  }, [pendingRepo?.status, pendingUrl, onClose, onRepoReady]);

  if (!open) return null;

  const handleInputChange = (value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (value.trim().length >= 2) {
      debounceRef.current = setTimeout(() => onSearch(value.trim()), 300);
    }
  };

  const handleSelect = async (url: string) => {
    setSubmitting(true);
    try {
      await onAdd(url);
      setPendingUrl(url);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmitUrl = async () => {
    const url = query.trim();
    if (!url) return;
    setSubmitting(true);
    try {
      await onAdd(url);
      setPendingUrl(url);
    } finally {
      setSubmitting(false);
    }
  };

  const isCloning = pendingRepo?.status === "cloning";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-lg bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-300 dark:border-gray-700 px-4 py-3">
          <h2 className="text-sm font-medium text-gray-900 dark:text-gray-200">Add Repository</h2>
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
          {/* Clone progress indicator */}
          {isCloning && (
            <div className="mb-3 flex items-center gap-2 rounded-md border border-amber-300/50 dark:border-amber-800/50 bg-amber-50/50 dark:bg-amber-950/30 px-3 py-2">
              <svg className="h-4 w-4 animate-spin text-amber-500 dark:text-amber-400" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              <span className="text-xs text-amber-700 dark:text-amber-300">Cloning repository...</span>
            </div>
          )}

          <div className="relative">
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => handleInputChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSubmitUrl();
                if (e.key === "Escape") onClose();
              }}
              placeholder="Search GitHub repos or paste a URL..."
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-500 focus:border-blue-500 focus:outline-none"
              disabled={submitting || isCloning}
            />
          </div>

          {/* Loading spinner while fetching initial repo list */}
          {loadingRepos && !isCloning && (
            <div className="mt-4 flex items-center justify-center gap-2 py-6">
              <svg className="h-4 w-4 animate-spin text-gray-400" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              <span className="text-xs text-gray-500">Loading repositories...</span>
            </div>
          )}

          {/* Search results */}
          {searchResults.length > 0 && !isCloning && (
            <div className="mt-2 max-h-64 overflow-y-auto rounded-md border border-gray-300 dark:border-gray-700">
              {searchResults.map((repo) => (
                <button
                  key={repo.cloneUrl}
                  onClick={() => handleSelect(repo.cloneUrl)}
                  disabled={submitting}
                  className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors border-b border-gray-200/50 dark:border-gray-700/50 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-900 dark:text-gray-200 truncate">{repo.fullName}</span>
                      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                        repo.private ? "bg-amber-100/50 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300" : "bg-green-100/50 dark:bg-green-900/50 text-green-700 dark:text-green-300"
                      }`}>
                        {repo.private ? "Private" : "Public"}
                      </span>
                    </div>
                    {repo.description && (
                      <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400 truncate">{repo.description}</p>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}

          {query.trim().length > 0 && searchResults.length === 0 && !isCloning && !loadingRepos && (
            <p className="mt-2 text-xs text-gray-500">
              No results. Press Enter to add by URL.
            </p>
          )}
        </div>

        <div className="flex justify-between border-t border-gray-300 dark:border-gray-700 px-4 py-3">
          <button
            onClick={onCreateNew}
            className="rounded-md px-3 py-1.5 text-xs text-blue-600 dark:text-blue-400 hover:text-blue-500 dark:hover:text-blue-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            Create new repository
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmitUrl}
              disabled={!query.trim() || submitting || isCloning}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {submitting ? "Adding..." : "Add"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
