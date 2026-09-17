import { useState } from "react";
import { Spinner } from "./Spinner.js";
import { ICON_SIZE } from "../design-tokens.js";
import { bindSetting } from "./Settings/setting-binding.js";

export interface GitHubTokenFormProps {
  onSubmit: (token: string) => Promise<boolean | undefined>;
  /**
   * What the button says. The settings row shows this form with a credential
   * already stored, where the act is replacing one rather than connecting.
   */
  submitLabel?: string;
  /**
   * The first-run gate is a dialog whose only purpose is this box, so it takes
   * focus; a settings row beside four other cards does not.
   */
  autoFocus?: boolean;
  /** Another write over the same credential is in flight — a disconnect. */
  disabled?: boolean;
}

export function GitHubTokenForm({
  onSubmit,
  submitLabel = "Connect",
  autoFocus = true,
  disabled = false,
}: GitHubTokenFormProps) {
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const canSubmit = token.trim().length > 0 && !loading && !disabled;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setLoading(true);
    setError("");
    const sent = token;
    try {
      const result = await onSubmit(sent.trim());
      if (result === false) {
        setError("Invalid GitHub token. Make sure it's a classic token with the repo scope.");
      } else {
        /*
          A stored credential must not sit in the box afterwards. The card used
          to be replaced by the connected view on success, which unmounted this
          form and took the token with it; the row keeps it mounted so that the
          credential can be replaced, so the clearing has to be here.

          Only the value that was SENT is cleared — a save is a round trip and
          typing does not stop for it, so a box typed in since keeps what was
          typed. That is the rule every write in this feature follows.
        */
        setToken((current) => (current === sent ? "" : current));
      }
    } catch {
      setError("Failed to connect. Please try again.");
    }
    setLoading(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && canSubmit) {
      e.preventDefault();
      void handleSubmit();
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
        aria-label="GitHub personal access token"
        className="w-full rounded-lg bg-(--color-bg-secondary) border border-(--color-border-secondary) px-4 py-3 text-sm text-(--color-text-primary) placeholder-gray-500 focus:outline-none focus:border-(--color-border-focus) font-mono"
        autoFocus={autoFocus}
        disabled={loading || disabled}
        data-testid="github-token-input"
        {...bindSetting("integrations.github.connection")}
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
        aria-label={loading ? "Connecting to GitHub" : `${submitLabel} GitHub`}
        {...bindSetting("integrations.github.connection")}
      >
        {loading ? (
          <>
            <Spinner size={ICON_SIZE.SM} />
            Connecting...
          </>
        ) : (
          submitLabel
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
