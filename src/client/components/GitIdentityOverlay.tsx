import { useState } from "react";

export interface GitIdentityOverlayProps {
  onSubmit: (name: string, email: string) => void;
  onGitHubTokenSubmit: (token: string) => Promise<boolean>;
}

export function GitIdentityOverlay({ onSubmit, onGitHubTokenSubmit }: GitIdentityOverlayProps) {
  const [mode, setMode] = useState<"github" | "manual">("github");

  // GitHub mode state
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Manual mode state
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  const canSubmitToken = token.trim().length > 0 && !loading;
  const canSubmitManual = name.trim().length > 0 && email.trim().length > 0;

  const handleTokenSubmit = async () => {
    if (!canSubmitToken) return;
    setLoading(true);
    setError("");
    try {
      const success = await onGitHubTokenSubmit(token.trim());
      if (!success) {
        setError("Invalid GitHub token. Make sure it's a classic token with the repo scope.");
        setLoading(false);
      }
      // On success, parent will unmount this overlay
    } catch {
      setError("Failed to connect. Please try again.");
      setLoading(false);
    }
  };

  const handleManualSubmit = () => {
    if (canSubmitManual) {
      onSubmit(name.trim(), email.trim());
    }
  };

  const handleTokenKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && canSubmitToken) {
      e.preventDefault();
      handleTokenSubmit();
    }
  };

  const handleManualKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && canSubmitManual) {
      e.preventDefault();
      handleManualSubmit();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 dark:bg-gray-950/90 backdrop-blur-sm">
      <div className="max-w-md w-full mx-4 rounded-xl bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 p-8 space-y-6">
        {mode === "github" ? (
          <>
            <div className="space-y-2 text-center">
              <div className="flex justify-center mb-3">
                <svg className="w-10 h-10 text-gray-900 dark:text-gray-100" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                </svg>
              </div>
              <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                Connect GitHub
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Log in with GitHub to set up your git identity and enable push, pull requests, and more.
              </p>
            </div>

            <div className="space-y-3">
              <input
                type="password"
                value={token}
                onChange={(e) => {
                  setToken(e.target.value);
                  if (error) setError("");
                }}
                onKeyDown={handleTokenKeyDown}
                placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                className="w-full rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 px-4 py-3 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 font-mono"
                autoFocus
                disabled={loading}
                data-testid="github-token-input"
              />

              {error && (
                <p className="text-sm text-red-500 dark:text-red-400" data-testid="github-error">
                  {error}
                </p>
              )}

              <button
                onClick={handleTokenSubmit}
                disabled={!canSubmitToken}
                className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                data-testid="github-connect"
              >
                {loading ? (
                  <>
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Connecting...
                  </>
                ) : (
                  "Connect"
                )}
              </button>

              <p className="text-xs text-gray-500 text-center">
                Use a{" "}
                <a
                  href="https://github.com/settings/tokens/new"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-400 hover:text-blue-300"
                >
                  classic Personal Access Token
                </a>{" "}
                with the <code className="text-xs bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded">repo</code> scope.
              </p>
            </div>

            <div className="text-center">
              <button
                onClick={() => setMode("manual")}
                className="text-sm text-gray-500 hover:text-gray-300 transition-colors"
                data-testid="switch-manual"
              >
                Set up manually instead
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="space-y-2 text-center">
              <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                Git Identity
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Enter your name and email for git commits.
              </p>
            </div>

            <div className="space-y-3">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={handleManualKeyDown}
                placeholder="Your Name"
                className="w-full rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 px-4 py-3 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
                autoFocus
              />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={handleManualKeyDown}
                placeholder="you@example.com"
                className="w-full rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 px-4 py-3 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
              />
              <button
                onClick={handleManualSubmit}
                disabled={!canSubmitManual}
                className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Save
              </button>
            </div>

            <div className="text-center">
              <button
                onClick={() => setMode("github")}
                className="text-sm text-gray-500 hover:text-gray-300 transition-colors"
                data-testid="switch-github"
              >
                Connect GitHub instead
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
