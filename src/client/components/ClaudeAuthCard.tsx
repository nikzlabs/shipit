import { useState } from "react";
import type { AgentOption } from "../agent-types.js";

export interface ClaudeAuthCardProps {
  agent: AgentOption | undefined;
  authUrl: string | null;
  onStartAuth: () => void;
  onApiKeySubmit: (key: string) => Promise<boolean | undefined>;
  onPasteAuthCode: (code: string) => void;
  onClearApiKey?: () => Promise<void> | void;
  /**
   * True when Claude has stored credentials/account state on the server even
   * though the agent is *not* authenticated (`authConfigured === false`) — e.g.
   * an account row whose on-disk token is stale or unverifiable. Gates the
   * "Clear saved credentials" escape hatch in the not-authenticated panel so a
   * pristine first-run card stays clutter-free.
   */
  hasStoredCredentials?: boolean;
}

/**
 * Settings → Agent → Claude card. Compact single-row layout that mirrors
 * `CodexAuthCard` so the two agents read as siblings, and so the card stays
 * tight wherever it's reused (Settings tab + onboarding step 2):
 *
 *   1. **Status + action row** — installed / authenticated state on one line,
 *      with the action inline on the right: "Sign out" when authenticated, or
 *      "Sign in" when unauthed. The richer flows expand *below* this row only
 *      when needed, so the resting card is a single line.
 *   2. **OAuth flow** (expands inline when unauthed) — "Sign in" drives the
 *      Anthropic OAuth flow; when the orchestrator returns the OAuth URL the
 *      row's button is replaced by a Step 1 / Step 2 panel (open URL + paste
 *      auth code). Step 2 differs from Codex by necessity: Anthropic uses a
 *      paste-back authorization code, OpenAI uses device-auth where the user
 *      enters a code on the provider's page.
 *   3. **Use API key instead** (collapsed disclosure, inline) — preserves the
 *      `sk-ant-…` fallback, visually deprioritized to match Codex's
 *      API-key disclosure.
 *
 * "Sign out" performs a full sign-out: the `DELETE /api/auth/api-key` route
 * clears both the stored API key and the OAuth credentials on disk
 * (`~/.claude/.credentials.json` and siblings), then refreshes the agent
 * registry so this card flips back to the "Sign in" state.
 *
 * The same full-reset is also surfaced as a "Clear saved credentials" escape
 * hatch in the *not-authenticated* panel (gated by `hasStoredCredentials`):
 * when an account's on-disk token is stale/unverifiable the agent reads as
 * unauthenticated, the top-right "Sign out" is hidden, and the per-account
 * "Disconnect" is blocked while sessions are pinned — leaving no other way to
 * clear the stale state and re-authenticate. `DELETE /api/auth/api-key` is not
 * blocked by pinned sessions, so it is the right reset path here.
 */
export function ClaudeAuthCard({
  agent,
  authUrl,
  onStartAuth,
  onApiKeySubmit,
  onPasteAuthCode,
  onClearApiKey,
  hasStoredCredentials = false,
}: ClaudeAuthCardProps) {
  const [apiKey, setApiKey] = useState("");
  const [apiKeyError, setApiKeyError] = useState("");
  const [apiKeyLoading, setApiKeyLoading] = useState(false);
  const [authCode, setAuthCode] = useState("");
  const [authCodeSubmitted, setAuthCodeSubmitted] = useState(false);
  const [authPendingLocal, setAuthPendingLocal] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [showApiKeyPanel, setShowApiKeyPanel] = useState(false);

  // Derive effective authPending: auto-clears when authUrl arrives or agent becomes authenticated
  const authPending = authPendingLocal && authUrl === null && !agent?.authConfigured;

  if (!agent) return null;

  const handleStartAuth = () => {
    setAuthPendingLocal(true);
    onStartAuth();
  };

  const handleClearCredentials = async () => {
    if (!onClearApiKey || signingOut) return;
    setSigningOut(true);
    try {
      await onClearApiKey();
    } finally {
      setSigningOut(false);
    }
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
    <div className="space-y-2" data-testid="claude-auth-card">
      {/* Compact status + action row: the status badge and the sign-in button
          live on one line so the resting card is a single row. The OAuth flow,
          API-key input, and escape hatches expand inline below only when
          needed — keeps Settings and onboarding tight. */}
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
            onClick={() => void handleClearCredentials()}
            disabled={signingOut}
            className="shrink-0 text-xs px-2 py-1 rounded-md text-(--color-text-secondary) hover:text-(--color-text-primary) hover:bg-(--color-bg-hover) transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="claude-sign-out"
          >
            {signingOut ? "Signing out..." : "Sign out"}
          </button>
        )}
        {/* Sign in lives in the row at rest; clicking it expands the OAuth
            panel below (which then hides this button). */}
        {needsAuth && !isPending && (
          <button
            onClick={handleStartAuth}
            disabled={authPending}
            className="shrink-0 rounded-lg bg-(--color-accent) px-4 py-2 text-sm font-medium text-(--color-accent-text) hover:bg-(--color-accent-hover) transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="claude-start-auth"
          >
            {authPending ? "Starting..." : "Sign in"}
          </button>
        )}
      </div>

      {/* Pending state: OAuth URL + auth-code paste field, expanded inline. */}
      {needsAuth && isPending && (
        <div
          className="space-y-3 rounded-lg bg-(--color-bg-secondary) border border-(--color-border-secondary) p-3"
          data-testid="claude-oauth-flow"
        >
          <p className="text-xs text-(--color-text-secondary)">
            Step 1 — open this link and sign in:
          </p>
          <a
            href={authUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full rounded-lg bg-(--color-accent) px-4 py-2.5 text-sm font-medium text-(--color-accent-text) hover:bg-(--color-accent-hover) transition-colors text-center"
            data-testid="claude-open-auth-url"
          >
            Open authentication page
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

      {/* Idle helpers: stale-credential reset + API-key disclosure, expanded
          inline below the row only when unauthenticated and not mid-OAuth. */}
      {needsAuth && !isPending && (
        <div className="space-y-2">
          {/* Escape hatch: when stale/unverifiable credentials are stored
              (agent reads as unauthenticated), let the user wipe them and
              start over. Hidden on a pristine first-run card. */}
          {hasStoredCredentials && onClearApiKey && (
            <div className="px-1" data-testid="claude-stale-credentials">
              <p className="text-xs text-(--color-text-tertiary)">
                Saved credentials couldn&apos;t be verified.
              </p>
              <button
                onClick={() => void handleClearCredentials()}
                disabled={signingOut}
                className="mt-0.5 text-xs text-(--color-text-link) hover:text-(--color-accent) transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="claude-clear-credentials"
              >
                {signingOut ? "Clearing..." : "Clear saved credentials"}
              </button>
            </div>
          )}

          {/* Disclosure: API key fallback. Collapsed by default to keep the
              OAuth flow as the primary affordance — matches CodexAuthCard. */}
          <div className="px-1">
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
                  Bills against your API account, not your subscription.
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
        </div>
      )}
    </div>
  );
}
