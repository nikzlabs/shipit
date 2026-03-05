import { useState, useRef, useEffect } from "react";
import type { RepoInfo } from "../../server/shared/types.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Modal } from "./ui/modal.js";

interface AddRepoDialogProps {
  open: boolean;
  onClose: () => void;
  onAdd: (url: string) => Promise<void>;
  onCreateNew: () => void;
  /** Called when a newly-added repo finishes cloning and is ready. */
  onRepoReady?: (url: string) => void;
  searchResults: { fullName: string; description: string | null; private: boolean; cloneUrl: string }[];
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
    <Modal
      onClose={onClose}
      className="w-full max-w-lg rounded-lg border-(--color-border-secondary)"
    >
        <div className="flex items-center justify-between border-b border-(--color-border-secondary) px-4 py-3">
          <h2 className="text-sm font-medium text-(--color-text-primary)">Add Repository</h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Close"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </Button>
        </div>

        <div className="p-4">
          {/* Clone progress indicator */}
          {isCloning && (
            <div className="mb-3 flex items-center gap-2 rounded-md border border-(--color-warning)/50 bg-(--color-warning-subtle) px-3 py-2">
              <svg className="h-4 w-4 animate-spin text-(--color-warning)" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              <span className="text-xs text-(--color-warning)">Cloning repository...</span>
            </div>
          )}

          <div className="relative">
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => handleInputChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSubmitUrl();
                if (e.key === "Escape") onClose();
              }}
              placeholder="Search GitHub repos or paste a URL..."
              className="w-full rounded-md border border-(--color-border-secondary) bg-(--color-bg-secondary) px-3 py-2 text-sm text-(--color-text-primary) placeholder-(--color-text-tertiary) focus:border-(--color-border-focus) focus:outline-none"
              disabled={submitting || isCloning}
            />
          </div>

          {/* Loading spinner while fetching initial repo list */}
          {loadingRepos && !isCloning && (
            <div className="mt-4 flex items-center justify-center gap-2 py-6">
              <svg className="h-4 w-4 animate-spin text-(--color-text-tertiary)" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              <span className="text-xs text-(--color-text-secondary)">Loading repositories...</span>
            </div>
          )}

          {/* Search results */}
          {searchResults.length > 0 && !isCloning && (
            <div className="mt-2 max-h-64 overflow-y-auto rounded-md border border-(--color-border-secondary)">
              {searchResults.map((repo) => (
                <button
                  key={repo.cloneUrl}
                  onClick={() => handleSelect(repo.cloneUrl)}
                  disabled={submitting}
                  className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-(--color-bg-hover) transition-colors border-b border-(--color-border-primary)/50 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-(--color-text-primary) truncate">{repo.fullName}</span>
                      <Badge variant={repo.private ? "warning" : "success"} className="shrink-0 text-[10px]">
                        {repo.private ? "Private" : "Public"}
                      </Badge>
                    </div>
                    {repo.description && (
                      <p className="mt-0.5 text-xs text-(--color-text-secondary) truncate">{repo.description}</p>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}

          {query.trim().length > 0 && searchResults.length === 0 && !isCloning && !loadingRepos && (
            <p className="mt-2 text-xs text-(--color-text-secondary)">
              No results. Press Enter to add by URL.
            </p>
          )}
        </div>

        <div className="flex justify-between border-t border-(--color-border-secondary) px-4 py-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={onCreateNew}
            className="text-(--color-text-link) hover:text-(--color-accent)"
          >
            Create new repository
          </Button>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleSubmitUrl}
              disabled={!query.trim() || submitting || isCloning}
            >
              {submitting ? "Adding..." : "Add"}
            </Button>
          </div>
        </div>
    </Modal>
  );
}
