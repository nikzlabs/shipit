import { useState, useEffect, useRef } from "react";

export interface PullRequestModalProps {
  currentBranch: string;
  remoteBranches: string[];
  defaultTitle?: string;
  onSubmit: (data: { title: string; body: string; base: string; draft: boolean }) => void;
  onRequestBranches: () => void;
  onGenerateDescription?: () => void;
  onClose: () => void;
  /** Result from the server after PR creation. */
  result?: { success: boolean; url?: string; number?: number; message?: string } | null;
  /** Whether AI description generation is in progress. */
  isGeneratingDescription?: boolean;
  /** Error from description generation. */
  generateDescriptionError?: string | null;
  /** Generated description text from the server — sets the body when it arrives. */
  generatedDescription?: string | null;
}

export function PullRequestModal({
  currentBranch,
  remoteBranches,
  defaultTitle = "",
  onSubmit,
  onRequestBranches,
  onGenerateDescription,
  onClose,
  result,
  isGeneratingDescription = false,
  generateDescriptionError = null,
  generatedDescription = null,
}: PullRequestModalProps) {
  const [title, setTitle] = useState(defaultTitle);
  const [body, setBody] = useState("");
  const [base, setBase] = useState("");
  const [draft, setDraft] = useState(false);
  const [titleError, setTitleError] = useState("");
  const [showReplaceConfirm, setShowReplaceConfirm] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);

  // Request branches on mount
  useEffect(() => {
    onRequestBranches();
  }, [onRequestBranches]);

  // Auto-select base branch (prefer "main", then "master", then first available)
  useEffect(() => {
    if (base || remoteBranches.length === 0) return;
    if (remoteBranches.includes("main")) {
      setBase("main");
    } else if (remoteBranches.includes("master")) {
      setBase("master");
    } else {
      setBase(remoteBranches[0]);
    }
  }, [remoteBranches, base]);

  // Apply generated description when it arrives
  useEffect(() => {
    if (generatedDescription) {
      setBody(generatedDescription);
      setShowReplaceConfirm(false);
    }
  }, [generatedDescription]);

  // Focus title input on mount
  useEffect(() => {
    titleInputRef.current?.focus();
  }, []);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleSubmit = () => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setTitleError("PR title is required");
      return;
    }
    if (trimmedTitle.length > 256) {
      setTitleError("PR title too long (max 256 characters)");
      return;
    }
    setTitleError("");
    onSubmit({ title: trimmedTitle, body: body.trim(), base, draft });
  };

  const handleGenerateDescription = () => {
    if (!onGenerateDescription) return;
    if (body.trim()) {
      setShowReplaceConfirm(true);
      return;
    }
    onGenerateDescription();
  };

  const handleConfirmReplace = () => {
    setShowReplaceConfirm(false);
    onGenerateDescription?.();
  };

  const showSuccess = result?.success;
  const showError = result && !result.success;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="bg-white dark:bg-gray-900 rounded-lg shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Create Pull Request
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-6 py-4 space-y-4">
          {showSuccess ? (
            /* Success state */
            <div className="text-center py-4">
              <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-green-100 dark:bg-green-900 flex items-center justify-center">
                <svg className="w-6 h-6 text-green-600 dark:text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-300 mb-2">
                Pull request #{result?.number} created successfully
              </p>
              {result?.url && (
                <a
                  href={result.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-blue-600 dark:text-blue-400 hover:underline break-all"
                >
                  {result.url}
                </a>
              )}
              <div className="mt-4">
                <button
                  onClick={onClose}
                  className="px-4 py-2 text-sm font-medium rounded-md bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          ) : (
            /* Form state */
            <>
              {/* Branch info */}
              <div className="flex items-center gap-2 text-sm">
                <span className="text-gray-500 dark:text-gray-400">From:</span>
                <span className="px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 font-mono text-xs">
                  {currentBranch || "..."}
                </span>
                <span className="text-gray-400 dark:text-gray-500">into</span>
                <select
                  value={base}
                  onChange={(e) => setBase(e.target.value)}
                  className="px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 font-mono text-xs border border-gray-300 dark:border-gray-600"
                  aria-label="Base branch"
                >
                  {remoteBranches.length === 0 && (
                    <option value="">Loading...</option>
                  )}
                  {remoteBranches.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </div>

              {/* Title */}
              <div>
                <label
                  htmlFor="pr-title"
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                >
                  Title
                </label>
                <input
                  ref={titleInputRef}
                  id="pr-title"
                  type="text"
                  value={title}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    if (titleError) setTitleError("");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSubmit();
                  }}
                  placeholder="Add a title"
                  className={`w-full px-3 py-2 rounded-md border text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 ${
                    titleError
                      ? "border-red-500 dark:border-red-400"
                      : "border-gray-300 dark:border-gray-600"
                  } focus:outline-none focus:ring-2 focus:ring-blue-500`}
                />
                {titleError && (
                  <p className="mt-1 text-xs text-red-600 dark:text-red-400">{titleError}</p>
                )}
              </div>

              {/* Description */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label
                    htmlFor="pr-body"
                    className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                  >
                    Description
                  </label>
                  {onGenerateDescription && (
                    <button
                      onClick={handleGenerateDescription}
                      disabled={isGeneratingDescription}
                      className="text-xs text-blue-500 hover:text-blue-400 disabled:text-gray-500 disabled:cursor-not-allowed transition-colors"
                      type="button"
                    >
                      {isGeneratingDescription ? "Generating..." : "Ask Claude to write description"}
                    </button>
                  )}
                </div>
                <textarea
                  id="pr-body"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="Describe the changes..."
                  rows={6}
                  className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
                />
                {showReplaceConfirm && (
                  <div className="mt-1 flex items-center gap-2 text-xs">
                    <span className="text-yellow-500">Replace current description?</span>
                    <button
                      onClick={handleConfirmReplace}
                      className="text-blue-500 hover:text-blue-400"
                      type="button"
                    >
                      Yes, replace
                    </button>
                    <button
                      onClick={() => setShowReplaceConfirm(false)}
                      className="text-gray-400 hover:text-gray-300"
                      type="button"
                    >
                      No, keep it
                    </button>
                  </div>
                )}
                {generateDescriptionError && (
                  <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                    {generateDescriptionError}
                  </p>
                )}
              </div>

              {/* Draft checkbox */}
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={draft}
                  onChange={(e) => setDraft(e.target.checked)}
                  className="rounded border-gray-300 dark:border-gray-600"
                />
                Create as draft
              </label>

              {/* Error from server */}
              {showError && (
                <p className="text-sm text-red-600 dark:text-red-400">
                  {result?.message || "Failed to create pull request"}
                </p>
              )}

              {/* Actions */}
              <div className="flex justify-end gap-2 pt-2">
                <button
                  onClick={onClose}
                  className="px-4 py-2 text-sm font-medium rounded-md bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSubmit}
                  className="px-4 py-2 text-sm font-medium rounded-md bg-green-600 text-white hover:bg-green-700 transition-colors"
                >
                  Create PR
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
