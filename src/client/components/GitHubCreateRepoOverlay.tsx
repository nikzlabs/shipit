import { useState } from "react";

export interface GitHubCreateRepoOverlayProps {
  username: string;
  onSubmit: (name: string, description: string, isPrivate: boolean) => void;
  onClose: () => void;
}

export function GitHubCreateRepoOverlay({ username, onSubmit, onClose }: GitHubCreateRepoOverlayProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);

  const trimmedName = name.trim();
  const isValidName = /^[a-zA-Z0-9._-]+$/.test(trimmedName);

  const handleSubmit = () => {
    if (trimmedName && isValidName) {
      onSubmit(trimmedName, description.trim(), isPrivate);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && trimmedName && isValidName) {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === "Escape") {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 dark:bg-gray-950/90 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="max-w-md w-full mx-4 rounded-xl bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 p-8 space-y-6">
        <div className="space-y-2 text-center">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            Create GitHub Repository
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Create a new repository under <span className="text-gray-800 dark:text-gray-200 font-medium">{username}</span> and automatically configure it as the remote.
          </p>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm text-gray-700 dark:text-gray-300 mb-1">Repository name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="my-project"
              className="w-full rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 px-4 py-2.5 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 font-mono"
              autoFocus
            />
            {trimmedName && !isValidName && (
              <p className="text-xs text-red-400 mt-1">
                Only letters, numbers, hyphens, dots, and underscores allowed.
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm text-gray-700 dark:text-gray-300 mb-1">Description (optional)</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="A short description of the project"
              className="w-full rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 px-4 py-2.5 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setIsPrivate(false)}
              className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium border transition-colors ${
                !isPrivate
                  ? "bg-gray-200 dark:bg-gray-700 border-blue-500 text-gray-900 dark:text-gray-100"
                  : "bg-gray-100 dark:bg-gray-800 border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500"
              }`}
            >
              Public
            </button>
            <button
              type="button"
              onClick={() => setIsPrivate(true)}
              className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium border transition-colors ${
                isPrivate
                  ? "bg-gray-200 dark:bg-gray-700 border-blue-500 text-gray-900 dark:text-gray-100"
                  : "bg-gray-100 dark:bg-gray-800 border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500"
              }`}
            >
              Private
            </button>
          </div>

          <div className="flex gap-3 pt-2">
            <button
              onClick={onClose}
              className="flex-1 rounded-lg bg-gray-100 dark:bg-gray-800 px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={!trimmedName || !isValidName}
              className="flex-1 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Create Repository
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
