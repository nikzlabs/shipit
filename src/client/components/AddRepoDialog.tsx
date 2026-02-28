import { useState, useRef, useEffect } from "react";

interface AddRepoDialogProps {
  open: boolean;
  onClose: () => void;
  onAdd: (url: string) => Promise<void>;
  searchResults: Array<{ fullName: string; description: string | null; private: boolean; cloneUrl: string }>;
  onSearch: (query: string) => void;
}

export function AddRepoDialog({ open, onClose, onAdd, searchResults, onSearch }: AddRepoDialogProps) {
  const [query, setQuery] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (open) {
      setQuery("");
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

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
      onClose();
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
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-lg bg-gray-900 border border-gray-700 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-700 px-4 py-3">
          <h2 className="text-sm font-medium text-gray-200">Add Repository</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-200 transition-colors"
            aria-label="Close"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-4">
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
              className="w-full rounded-md border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:border-blue-500 focus:outline-none"
              disabled={submitting}
            />
          </div>

          {/* Search results */}
          {searchResults.length > 0 && (
            <div className="mt-2 max-h-64 overflow-y-auto rounded-md border border-gray-700">
              {searchResults.map((repo) => (
                <button
                  key={repo.cloneUrl}
                  onClick={() => handleSelect(repo.cloneUrl)}
                  disabled={submitting}
                  className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-gray-800 transition-colors border-b border-gray-700/50 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-200 truncate">{repo.fullName}</span>
                      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                        repo.private ? "bg-amber-900/50 text-amber-300" : "bg-green-900/50 text-green-300"
                      }`}>
                        {repo.private ? "Private" : "Public"}
                      </span>
                    </div>
                    {repo.description && (
                      <p className="mt-0.5 text-xs text-gray-400 truncate">{repo.description}</p>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}

          {query.trim().length > 0 && searchResults.length === 0 && (
            <p className="mt-2 text-xs text-gray-500">
              No results. Press Enter to add by URL.
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-gray-700 px-4 py-3">
          <button
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmitUrl}
            disabled={!query.trim() || submitting}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {submitting ? "Adding..." : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}
