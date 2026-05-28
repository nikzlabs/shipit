// eslint-disable-next-line no-restricted-imports -- useEffect: auto-close on async repo clone completion (reacts to external process finishing)
import { useState, useRef, useEffect } from "react";
import { XIcon, CircleNotchIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import type { RepoInfo } from "../../server/shared/types.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog.js";

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

  // Reset state when dialog opens (inline state reset during render)
  const prevOpenRef = useRef(false);
  if (open && !prevOpenRef.current) {
    setQuery("");
    setPendingUrl(null);
    // Lazy-load the user's GitHub repos on first open
    if (searchResults.length === 0) {
      setLoadingRepos(true);
      queueMicrotask(() => {
        // eslint-disable-next-line no-restricted-syntax -- Promise two-arg form for loading state
        Promise.resolve(onSearch("")).then(
          () => setLoadingRepos(false),
          () => setLoadingRepos(false),
        );
      });
    }
    queueMicrotask(() => inputRef.current?.focus());
  }
  prevOpenRef.current = open;

  // Auto-close and navigate when the pending repo becomes ready
  const pendingRepo = pendingUrl ? repos.find((r) => r.url === pendingUrl) : null;
  // eslint-disable-next-line no-restricted-syntax -- existing usage
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
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent className="w-full max-w-lg rounded-lg border-(--color-border-secondary)">
        <div className="flex items-center justify-between border-b border-(--color-border-secondary) px-4 py-3">
          <DialogTitle className="text-sm font-medium text-(--color-text-primary)">Add Repository</DialogTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="h-9 w-9 max-md:h-10 max-md:w-10"
            aria-label="Close"
          >
            <XIcon size={ICON_SIZE.MD} weight="bold" />
          </Button>
        </div>

        <div className="p-4">
          {/* Clone progress indicator */}
          {isCloning && (
            <div className="mb-3 flex items-center gap-2 rounded-md border border-(--color-warning)/50 bg-(--color-warning-subtle) px-3 py-2">
              <CircleNotchIcon size={ICON_SIZE.SM} className="animate-spin text-(--color-warning)" />
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
              }}
              placeholder="Search GitHub repos or paste a URL..."
              className="w-full rounded-md border border-(--color-border-secondary) bg-(--color-bg-secondary) px-3 py-2 text-sm text-(--color-text-primary) placeholder-(--color-text-tertiary) focus:border-(--color-border-focus) focus:outline-none"
              disabled={submitting || isCloning}
            />
          </div>

          {/* Loading spinner while fetching initial repo list */}
          {loadingRepos && !isCloning && (
            <div className="mt-4 flex items-center justify-center gap-2 py-6">
              <CircleNotchIcon size={ICON_SIZE.SM} className="animate-spin text-(--color-text-tertiary)" />
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
      </DialogContent>
    </Dialog>
  );
}
