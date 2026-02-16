import { useState } from "react";

export interface GitHubAuthOverlayProps {
  onSubmit: (token: string) => void;
  onClose: () => void;
}

export function GitHubAuthOverlay({ onSubmit, onClose }: GitHubAuthOverlayProps) {
  const [token, setToken] = useState("");

  const handleSubmit = () => {
    const trimmed = token.trim();
    if (trimmed) {
      onSubmit(trimmed);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === "Escape") {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/90 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="max-w-md w-full mx-4 rounded-xl bg-gray-900 border border-gray-700 p-8 space-y-6">
        <div className="space-y-2 text-center">
          <h2 className="text-xl font-semibold text-gray-100">
            Connect to GitHub
          </h2>
          <p className="text-sm text-gray-400">
            Enter a Personal Access Token to push and pull from GitHub repositories.
            The token needs the <code className="text-xs bg-gray-800 px-1 py-0.5 rounded">repo</code> scope.
          </p>
        </div>

        <div className="space-y-3">
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
            className="w-full rounded-lg bg-gray-800 border border-gray-600 px-4 py-3 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 font-mono"
            autoFocus
          />

          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 rounded-lg bg-gray-800 px-4 py-2.5 text-sm font-medium text-gray-300 hover:bg-gray-700 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={!token.trim()}
              className="flex-1 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Connect
            </button>
          </div>
        </div>

        <div className="pt-2 border-t border-gray-800">
          <p className="text-xs text-gray-500">
            Your token is stored locally and never shared. Create one at{" "}
            <a
              href="https://github.com/settings/tokens"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:text-blue-300"
            >
              GitHub Settings
            </a>.
          </p>
        </div>
      </div>
    </div>
  );
}
