import { useState } from "react";
import type { AgentOption } from "./AgentPicker.js";

export interface ClaudeAuthCardProps {
  agent: AgentOption | undefined;
  authUrl: string | null;
  onStartAuth: () => void;
  onApiKeySubmit: (key: string) => Promise<boolean | undefined>;
  onPasteAuthCode: (code: string) => void;
  onClearApiKey?: () => Promise<void> | void;
}

/**
 * Settings → Agent → Claude card. Layout mirrors `CodexAuthCard` so the two
 * agents read as siblings:
 *
 *   1. **Status badge** — installed / authenticated state, with an inline
 *      "Clear API key" button (top-right) when authenticated.
 *   2. **Login with Claude** (primary, when unauthed) — drives the existing
 *      OAuth flow. When the orchestrator returns the OAuth URL, the panel
 *      flips to a Step 1 / Step 2 view (open URL + paste auth code).
 *   3. **Use API key instead** (collapsed disclosure) — preserves the
 *      `sk-ant-…` fallback, visually deprioritized to match Codex's
 *      `OPENAI_API_KEY` disclosure. To switch from OAuth back to an API
 *      key while authenticated, the user clicks "Clear API key" first.
 */
export function ClaudeAuthCard({
  agent,
  authUrl,
  onStartAuth,
  onApiKeySubmit,
  onPasteAuthCode,
  onClearApiKey,
}: ClaudeAuthCardProps) {
  const [apiKey, setApiKey] = useState("");
  const [apiKeyError, setApiKeyError] = useState("");
  const [apiKeyLoading, setApiKeyLoading] = useState(false);
  const [authCode, setAuthCode] = useState("");
  const [authCodeSubmitted, setAuthCodeSubmitted] = useState(false);
  const [authPendingLocal, setAuthPendingLocal] = useState(false);
  const [clearingApiKey, setClearingApiKey] = useState(false);
  const [showApiKeyPanel, setShowApiKeyPanel] = useState(false);

  // Derive effective authPending: auto-clears when authUrl arrives or agent becomes authenticated
  const authPending = authPendingLocal && authUrl === null && !agent?.authConfigured;

  if (!agent) return null;

  const handleStartAuth = () => {
    setAuthPendingLocal(true);
    onStartAuth();
  };

  const handleApiKeySubmit = async () => {
    const trimmed = apiKey.trim();
    if (!trimmed) return;
    if (!trimmed.startsWith("sk-ant-")) {
      setApiKeyError("API key must start with sk-ant-");
      return;
    }
    setApiKeyLoading(true);
    setApiKeyError("");
    try {
      const result = await onApiKeySubmit(trimmed);
      if (result === false) {
        setApiKeyError("Failed to set API key.");
      } else {
        setApiKey("");
      }
    } catch {
      setApiKeyError("Failed to set API key.");
    }
    setApiKeyLoading(false);
  };

  const handleApiKeyKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && apiKey.trim()) {
      e.preventDefault();
      void handleApiKeySubmit();
    }
  };

  const handlePasteAuthCode = () => {
    if (authCode.trim()) {
      setAuthCodeSubmitted(true);
      onPasteAuthCode(authCode.trim());
    }
  };

  const needsAuth = agent.installed && !agent.authConfigured;
  const isPending = needsAuth && !!authUrl;

  return (
    <div className="space-y-3" data-testid="claude-auth-card">
      {/* Status badge */}
      <div className="flex items-center gap-3 p-3 rounded-lg bg-(--color-bg-secondary) border border-(--color-border-secondary)">
        <span
          className={`w-2.5 h-2.5 rounded-full shrink-0 ${
            !agent.installed
              ? "bg-(--color-text-tertiary)"
              : agent.authConfigured
                ? "bg-(--color-success)"
                : "bg-(--color-warning)"
          }`}
          data-testid="claude-status-dot"
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-(--color-text-primary)">
            {agent.name}
          </p>
          <p className="text-xs text-(--color-text-secondary)">
            {!agent.installed
              ? "Not installed"
              : agent.authConfigured
                ? "Authenticated"
                : "Not authenticated"}
          </p>
        </div>
        {agent.installed && agent.authConfigured && onClearApiKey && (
          <button
            onClick={async () => {
              if (clearingApiKey) return;
              setClearingApiKey(true);
              try {
                await onClearApiKey();
              } finally {
                setClearingApiKey(false);
              }
            }}
            disabled={clearingApiKey}
            className="shrink-0 text-xs px-2 py-1 rounded-md text-(--color-text-secondary) hover:text-(--color-text-primary) hover:bg-(--color-bg-hover) transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="claude-clear-api-key"
          >
            {clearingApiKey ? "Clearing..." : "Clear API key"}
          </button>
        )}
      </div>

      {/* Sign-in panel — only shown when not yet authenticated. */}
      {needsAuth && (
        <>
          {/* Pending state: OAuth URL + auth-code paste field */}
          {isPending && (
            <div
              className="space-y-3 rounded-lg bg-(--color-bg-secondary) border border-(--color-border-secondary) p-3"
              data-testid="claude-oauth-flow"
            >
              <p className="text-xs text-(--color-text-secondary)">
                Step 1 — open this link and sign in to Anthropic:
              </p>
              <a
                href={authUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="block w-full rounded-lg bg-(--color-accent) px-4 py-2.5 text-sm font-medium text-(--color-accent-text) hover:bg-(--color-accent-hover) transition-colors text-center"
                data-testid="claude-open-auth-url"
              >
                Open Authentication Page
              </a>
              <p className="text-xs text-(--color-text-secondary)">
                Step 2 — paste the authorization code:
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={authCode}
                  onChange={(e) => setAuthCode(e.target.value)}
                  placeholder="Paste code here..."
                  disabled={authCodeSubmitted}
                  className="flex-1 rounded-lg bg-(--color-bg-primary) border border-(--color-border-secondary) px-4 py-2.5 text-sm text-(--color-text-primary) placeholder-gray-500 focus:outline-none focus:border-(--color-border-focus) font-mono disabled:opacity-50"
                  data-testid="claude-auth-code-input"
                />
                <button
                  onClick={handlePasteAuthCode}
                  disabled={!authCode.trim() || authCodeSubmitted}
                  className="rounded-lg bg-(--color-accent) px-4 py-2.5 text-sm font-medium text-(--color-accent-text) hover:bg-(--color-accent-hover) transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                  data-testid="claude-auth-code-submit"
                >
                  {authCodeSubmitted ? "Submitted" : "Submit"}
                </button>
              </div>
            </div>
          )}

          {/* Idle state: pitch the OAuth flow */}
          {!isPending && (
            <div className="space-y-2 rounded-lg bg-(--color-bg-secondary) border border-(--color-border-secondary) p-3">
              <p className="text-sm font-medium text-(--color-text-primary)">
                Login with Claude
              </p>
              <p className="text-xs text-(--color-text-secondary)">
                Uses your existing Anthropic plan — recommended.
              </p>
              <button
                onClick={handleStartAuth}
                disabled={authPending}
                className="w-full rounded-lg bg-(--color-accent) px-4 py-2.5 text-sm font-medium text-(--color-accent-text) hover:bg-(--color-accent-hover) transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="claude-start-auth"
              >
                {authPending ? "Waiting for login..." : "Login with Claude"}
              </button>
            </div>
          )}

          {/* Disclosure: API key fallback. Collapsed by default to keep the
              OAuth flow as the primary affordance — matches CodexAuthCard. */}
          {!isPending && (
            <div>
              <button
                onClick={() => setShowApiKeyPanel((v) => !v)}
                className="text-xs text-(--color-text-link) hover:text-(--color-accent) transition-colors"
                data-testid="claude-toggle-api-key"
              >
                {showApiKeyPanel ? "Hide API key option" : "Use API key instead"}
              </button>
              {showApiKeyPanel && (
                <div className="mt-2 space-y-2">
                  <p className="text-xs text-(--color-text-tertiary)">
                    Bills against your Anthropic API account, not your Claude subscription.
                  </p>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => { setApiKey(e.target.value); setApiKeyError(""); }}
                    onKeyDown={handleApiKeyKeyDown}
                    placeholder="sk-ant-..."
                    className="w-full rounded-lg bg-(--color-bg-secondary) border border-(--color-border-secondary) px-4 py-3 text-sm text-(--color-text-primary) placeholder-gray-500 focus:outline-none focus:border-(--color-border-focus) font-mono"
                    disabled={apiKeyLoading}
                    data-testid="claude-api-key-input"
                  />
                  {apiKeyError && <p className="text-xs text-(--color-error)" data-testid="claude-api-key-error">{apiKeyError}</p>}
                  <button
                    onClick={handleApiKeySubmit}
                    disabled={!apiKey.trim() || apiKeyLoading}
                    className="w-full rounded-lg bg-(--color-bg-secondary) border border-(--color-border-secondary) px-4 py-2.5 text-sm font-medium text-(--color-text-primary) hover:bg-(--color-bg-hover) transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    data-testid="claude-api-key-submit"
                  >
                    Save API key
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
