import { useState, useEffect, useRef, useCallback } from "react";

interface RepoResult {
  fullName: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  cloneUrl: string;
}

interface ImportProgress {
  stage: "cloning" | "installing" | "ready";
  message: string;
}

export interface ImportRepoOverlayProps {
  onSearch: (query: string) => void;
  onImport: (url: string, branch?: string) => void;
  onClose: () => void;
  searchResults: RepoResult[];
  progress: ImportProgress | null;
  importing: boolean;
}

export function ImportRepoOverlay({
  onSearch,
  onImport,
  onClose,
  searchResults,
  progress,
  importing,
}: ImportRepoOverlayProps) {
  const [inputValue, setInputValue] = useState("");
  const [selectedRepo, setSelectedRepo] = useState<RepoResult | null>(null);
  const [branch, setBranch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleInputChange = useCallback(
    (value: string) => {
      setInputValue(value);
      setSelectedRepo(null);

      // Don't search if it looks like a URL
      if (value.startsWith("https://") || value.startsWith("git@")) return;

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

  const handleSelectRepo = useCallback((repo: RepoResult) => {
    setSelectedRepo(repo);
    setInputValue(repo.cloneUrl);
    setBranch(repo.defaultBranch);
  }, []);

  const handleSubmit = useCallback(() => {
    const url = inputValue.trim();
    if (!url) return;
    onImport(url, branch || undefined);
  }, [inputValue, branch, onImport]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "Enter" && !importing) {
        handleSubmit();
      }
    },
    [onClose, handleSubmit, importing],
  );

  const isUrl = inputValue.startsWith("https://") || inputValue.startsWith("git@") || /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(inputValue);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-gray-900 border border-gray-700 rounded-lg shadow-xl w-full max-w-lg mx-4"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <h2 className="text-sm font-semibold text-gray-100">Import from GitHub</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-200 transition-colors"
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* Search / URL input */}
          <div>
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={(e) => handleInputChange(e.target.value)}
              placeholder="Search repos or paste URL..."
              className="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
              disabled={importing}
            />
          </div>

          {/* Search results */}
          {searchResults.length > 0 && !isUrl && !selectedRepo && (
            <div className="max-h-48 overflow-y-auto border border-gray-700 rounded">
              {searchResults.map((repo) => (
                <button
                  key={repo.fullName}
                  onClick={() => handleSelectRepo(repo)}
                  className="w-full text-left px-3 py-2 hover:bg-gray-800 transition-colors border-b border-gray-700 last:border-b-0"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-200">{repo.fullName}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${repo.private ? "bg-yellow-900 text-yellow-300" : "bg-green-900 text-green-300"}`}>
                      {repo.private ? "private" : "public"}
                    </span>
                  </div>
                  {repo.description && (
                    <p className="text-xs text-gray-400 mt-0.5 truncate">{repo.description}</p>
                  )}
                </button>
              ))}
            </div>
          )}

          {/* Branch input */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Branch (optional)</label>
            <input
              type="text"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder={selectedRepo?.defaultBranch ?? "main"}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
              disabled={importing}
            />
          </div>

          {/* Progress */}
          {progress && (
            <div className="text-xs text-gray-400 space-y-1">
              <div className="flex items-center gap-2">
                {progress.stage === "ready" ? (
                  <span className="text-green-400">&#10003;</span>
                ) : (
                  <span className="animate-spin">&#8635;</span>
                )}
                <span>{progress.message}</span>
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-sm text-gray-400 hover:text-gray-200 transition-colors"
              disabled={importing}
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={importing || !inputValue.trim()}
              className="px-4 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {importing ? "Importing..." : "Import"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
