import { useState } from "react";
import type { AgentOption } from "./AgentPicker.js";

/**
 * State for an in-flight `codex login --device-auth` flow. The orchestrator
 * pushes this to the client over SSE when the CLI prints the verification
 * URL + user code; it stays set until `codex_auth_complete` /
 * `codex_auth_failed` arrives. See feature 119.
 */
export interface CodexDeviceAuthState {
  verificationUri: string;
  userCode: string;
  expiresInSec: number;
}

export interface CodexAuthCardProps {
  agent: AgentOption | undefined;
  /**
   * Active device-auth flow state, or `null` when no flow is running. Driven
   * from the SSE `codex_auth_pending` / `codex_auth_complete` /
   * `codex_auth_failed` events.
   */
  deviceAuth?: CodexDeviceAuthState | null;
  /** Last failure reason (if any) — surfaces inline as an error. */
  deviceAuthError?: string | null;
  /** Begin a `codex login --device-auth` flow. Server returns 202; events stream over SSE. */
  onStartDeviceAuth?: () => void;
  /** Cancel an in-flight device-auth flow. */
  onCancelDeviceAuth?: () => void;
  /** Sign out (delete `~/.codex/auth.json`). */
  onSignOut?: () => void;
  /** Save an `OPENAI_API_KEY` (the fallback / Platform-API path). */
  onApiKeySubmit: (key: string) => Promise<boolean | undefined>;
  /**
   * True when both a ChatGPT login (file) AND an `OPENAI_API_KEY` env are
   * configured. The adapter prefers the subscription, so the API key is
   * effectively ignored in that case — we surface a banner so the precedence
   * is visible.
   */
  apiKeyIgnored?: boolean;
}

/**
 * Settings → Agents card for Codex. Two-section layout:
 *
 *   1. **Sign in with ChatGPT** (primary) — drives `codex login --device-auth`
 *      via the orchestrator. When the verification URL + user code arrive,
 *      we render a Step 1 / Step 2 view with a button that opens the URL
 *      in a new tab and a copy-to-clipboard affordance for the code.
 *   2. **Use API key instead** (collapsed disclosure) — preserves the
 *      legacy `OPENAI_API_KEY` path for users without a subscription, but
 *      visually deprioritized. Bills against the OpenAI Platform account.
 *
 * When the user has both, the adapter strips `OPENAI_API_KEY` from the
 * spawned codex process — the `apiKeyIgnored` prop drives a banner that
 * makes the precedence visible.
 *
 * See docs/119-codex-subscription-auth/plan.md.
 */
export function CodexAuthCard({
  agent,
  deviceAuth = null,
  deviceAuthError = null,
  onStartDeviceAuth,
  onCancelDeviceAuth,
  onSignOut,
  onApiKeySubmit,
  apiKeyIgnored = false,
}: CodexAuthCardProps) {
  const [codexKey, setCodexKey] = useState("");
  const [codexKeyError, setCodexKeyError] = useState("");
  const [codexKeyLoading, setCodexKeyLoading] = useState(false);
  const [showApiKeyPanel, setShowApiKeyPanel] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);

  if (!agent) return null;

  const isPending = !!deviceAuth;

  const handleApiKeySubmit = async () => {
    const trimmed = codexKey.trim();
    if (!trimmed) return;
    setCodexKeyLoading(true);
    setCodexKeyError("");
    try {
      const result = await onApiKeySubmit(trimmed);
      if (result === false) {
        setCodexKeyError("Failed to set API key.");
      } else {
        setCodexKey("");
      }
    } catch {
      setCodexKeyError("Failed to set API key.");
    }
    setCodexKeyLoading(false);
  };

  const handleApiKeyKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && codexKey.trim()) {
      e.preventDefault();
      void handleApiKeySubmit();
    }
  };

  const copyUserCode = async () => {
    if (!deviceAuth?.userCode) return;
    try {
      await navigator.clipboard.writeText(deviceAuth.userCode);
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 1500);
    } catch {
      // Clipboard API not available — user can still type the code manually.
    }
  };

  return (
    <div className="space-y-3" data-testid="codex-auth-card">
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
          data-testid="codex-status-dot"
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
        {agent.installed && agent.authConfigured && onSignOut && (
          <button
            onClick={onSignOut}
            className="shrink-0 text-xs px-2 py-1 rounded-md text-(--color-text-secondary) hover:text-(--color-text-primary) hover:bg-(--color-bg-hover) transition-colors"
            data-testid="codex-sign-out"
          >
            Sign out
          </button>
        )}
      </div>

      {/* "API key ignored" banner — shown when both a ChatGPT login and an
          OPENAI_API_KEY are configured. The adapter strips the env key in
          that case, so the user paid for nothing on the Platform side. */}
      {apiKeyIgnored && (
        <div
          className="rounded-md border border-(--color-border-secondary) bg-(--color-bg-secondary)/60 px-3 py-2 text-xs text-(--color-text-secondary)"
          data-testid="codex-api-key-ignored"
        >
          <span className="text-(--color-text-primary) font-medium">
            Using ChatGPT subscription.
          </span>{" "}
          Your saved <code className="font-mono">OPENAI_API_KEY</code> is being ignored.
        </div>
      )}

      {/* Sign-in panel — only shown when not yet authenticated. */}
      {agent.installed && !agent.authConfigured && (
        <>
          {/* Pending state: URL + user code */}
          {isPending && deviceAuth && (
            <div
              className="space-y-3 rounded-lg bg-(--color-bg-secondary) border border-(--color-border-secondary) p-3"
              data-testid="codex-device-auth-pending"
            >
              <p className="text-xs text-(--color-text-secondary)">
                Step 1 — open this link and sign in to OpenAI:
              </p>
              <a
                href={deviceAuth.verificationUri}
                target="_blank"
                rel="noopener noreferrer"
                className="block w-full rounded-lg bg-(--color-accent) px-4 py-2.5 text-sm font-medium text-(--color-accent-text) hover:bg-(--color-accent-hover) transition-colors text-center"
                data-testid="codex-open-auth-url"
              >
                Open auth.openai.com
              </a>
              <p className="text-xs text-(--color-text-secondary)">
                Step 2 — enter this code on the OpenAI page:
              </p>
              <div className="flex items-center gap-2">
                <code
                  className="flex-1 rounded-md bg-(--color-bg-primary) border border-(--color-border-secondary) px-3 py-2 text-center text-base font-mono tracking-widest text-(--color-text-primary) select-all"
                  data-testid="codex-user-code"
                >
                  {deviceAuth.userCode}
                </code>
                <button
                  onClick={copyUserCode}
                  className="shrink-0 rounded-md border border-(--color-border-secondary) bg-(--color-bg-primary) px-3 py-2 text-xs text-(--color-text-secondary) hover:text-(--color-text-primary) hover:bg-(--color-bg-hover) transition-colors"
                  data-testid="codex-copy-code"
                >
                  {codeCopied ? "Copied" : "Copy"}
                </button>
              </div>
              <p className="text-xs text-(--color-text-tertiary)">
                Waiting for approval...
              </p>
              {onCancelDeviceAuth && (
                <button
                  onClick={onCancelDeviceAuth}
                  className="w-full rounded-md border border-(--color-border-secondary) bg-(--color-bg-primary) px-3 py-2 text-xs text-(--color-text-secondary) hover:text-(--color-text-primary) hover:bg-(--color-bg-hover) transition-colors"
                  data-testid="codex-cancel-auth"
                >
                  Cancel
                </button>
              )}
            </div>
          )}

          {/* Idle state: pitch the subscription flow */}
          {!isPending && (
            <div className="space-y-2 rounded-lg bg-(--color-bg-secondary) border border-(--color-border-secondary) p-3">
              <p className="text-sm font-medium text-(--color-text-primary)">
                Sign in with ChatGPT
              </p>
              <p className="text-xs text-(--color-text-secondary)">
                Uses your existing ChatGPT plan or Codex credits — recommended.
              </p>
              <button
                onClick={onStartDeviceAuth}
                disabled={!onStartDeviceAuth}
                className="w-full rounded-lg bg-(--color-accent) px-4 py-2.5 text-sm font-medium text-(--color-accent-text) hover:bg-(--color-accent-hover) transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="codex-start-device-auth"
              >
                Sign in
              </button>
              {deviceAuthError && (
                <p
                  className="text-xs text-(--color-error)"
                  data-testid="codex-device-auth-error"
                >
                  {deviceAuthError}
                </p>
              )}
            </div>
          )}

          {/* Disclosure: API key fallback. Collapsed by default to keep the
              subscription flow as the primary affordance. */}
          {!isPending && (
            <div>
              <button
                onClick={() => setShowApiKeyPanel((v) => !v)}
                className="text-xs text-(--color-text-link) hover:text-(--color-accent) transition-colors"
                data-testid="codex-toggle-api-key"
              >
                {showApiKeyPanel ? "Hide API key option" : "Use API key instead"}
              </button>
              {showApiKeyPanel && (
                <div className="mt-2 space-y-2">
                  <p className="text-xs text-(--color-text-tertiary)">
                    Bills against your OpenAI Platform account, not your ChatGPT subscription.
                  </p>
                  <input
                    type="password"
                    value={codexKey}
                    onChange={(e) => { setCodexKey(e.target.value); setCodexKeyError(""); }}
                    onKeyDown={handleApiKeyKeyDown}
                    placeholder="OPENAI_API_KEY"
                    className="w-full rounded-lg bg-(--color-bg-secondary) border border-(--color-border-secondary) px-4 py-3 text-sm text-(--color-text-primary) placeholder-gray-500 focus:outline-none focus:border-(--color-border-focus) font-mono"
                    disabled={codexKeyLoading}
                    data-testid="codex-api-key-input"
                  />
                  {codexKeyError && (
                    <p className="text-xs text-(--color-error)" data-testid="codex-api-key-error">
                      {codexKeyError}
                    </p>
                  )}
                  <button
                    onClick={handleApiKeySubmit}
                    disabled={!codexKey.trim() || codexKeyLoading}
                    className="w-full rounded-lg bg-(--color-bg-secondary) border border-(--color-border-secondary) px-4 py-2.5 text-sm font-medium text-(--color-text-primary) hover:bg-(--color-bg-hover) transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    data-testid="codex-api-key-submit"
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
