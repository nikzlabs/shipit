import { useState } from "react";

export interface GitHubTokenFormProps {
  onSubmit: (token: string) => Promise<boolean | void>;
}

export function GitHubTokenForm({ onSubmit }: GitHubTokenFormProps) {
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const canSubmit = token.trim().length > 0 && !loading;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setLoading(true);
    setError("");
    try {
      const result = await onSubmit(token.trim());
      if (result === false) {
        setError("Invalid GitHub token. Make sure it's a classic token with the repo scope.");
      }
    } catch {
      setError("Failed to connect. Please try again.");
    }
    setLoading(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && canSubmit) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="space-y-3" data-testid="github-token-form">
      <input
        type="password"
        value={token}
        onChange={(e) => { setToken(e.target.value); if (error) setError(""); }}
        onKeyDown={handleKeyDown}
        placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
        className="w-full rounded-lg bg-(--color-bg-secondary) border border-(--color-border-secondary) px-4 py-3 text-sm text-(--color-text-primary) placeholder-gray-500 focus:outline-none focus:border-(--color-border-focus) font-mono"
        autoFocus
        disabled={loading}
        data-testid="github-token-input"
      />

      {error && (
        <p className="text-sm text-(--color-error)" data-testid="github-token-error">
          {error}
        </p>
      )}

      <button
        onClick={handleSubmit}
        disabled={!canSubmit}
        className="w-full rounded-lg bg-(--color-accent) px-4 py-2.5 text-sm font-medium text-(--color-accent-text) hover:bg-(--color-accent-hover) transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        data-testid="github-token-submit"
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

      <p className="text-xs text-(--color-text-secondary) text-center">
        Use a{" "}
        <a
          href="https://github.com/settings/tokens/new"
          target="_blank"
          rel="noopener noreferrer"
          className="text-(--color-text-link) hover:text-(--color-accent)"
        >
          classic Personal Access Token
        </a>{" "}
        with the <code className="text-xs bg-(--color-bg-secondary) px-1 py-0.5 rounded">repo</code> scope.
        Add <code className="text-xs bg-(--color-bg-secondary) px-1 py-0.5 rounded">workflow</code> too if your project uses GitHub Actions.
      </p>
    </div>
  );
}
