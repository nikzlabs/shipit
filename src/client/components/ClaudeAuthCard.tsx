import { useState, useEffect } from "react";
import type { AgentOption } from "./AgentPicker.js";

export interface ClaudeAuthCardProps {
  agent: AgentOption | undefined;
  authUrl: string | null;
  onStartAuth: () => void;
  onApiKeySubmit: (key: string) => Promise<boolean | void>;
  onPasteAuthCode: (code: string) => void;
  onClearApiKey?: () => void;
  showApiKeyWhenAuthed?: boolean;
}

export function ClaudeAuthCard({
  agent,
  authUrl,
  onStartAuth,
  onApiKeySubmit,
  onPasteAuthCode,
  onClearApiKey,
  showApiKeyWhenAuthed,
}: ClaudeAuthCardProps) {
  const [apiKey, setApiKey] = useState("");
  const [apiKeyError, setApiKeyError] = useState("");
  const [apiKeyLoading, setApiKeyLoading] = useState(false);
  const [authCode, setAuthCode] = useState("");
  const [authPending, setAuthPending] = useState(false);

  // Reset authPending when authUrl arrives or agent becomes authenticated
  useEffect(() => {
    if (authUrl !== null || agent?.authConfigured) {
      setAuthPending(false);
    }
  }, [authUrl, agent?.authConfigured]);

  if (!agent) return null;

  const handleStartAuth = () => {
    setAuthPending(true);
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
      handleApiKeySubmit();
    }
  };

  const handlePasteAuthCode = () => {
    if (authCode.trim()) {
      onPasteAuthCode(authCode.trim());
    }
  };

  const needsAuth = agent.installed && !agent.authConfigured;
  const showApiKeyInput = needsAuth || (agent.authConfigured && showApiKeyWhenAuthed);

  return (
    <div className="space-y-3" data-testid="claude-auth-card">
      {/* Status badge */}
      <div className="flex items-center gap-3 p-3 rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700">
        <span
          className={`w-2.5 h-2.5 rounded-full shrink-0 ${
            !agent.installed
              ? "bg-gray-400"
              : agent.authConfigured
                ? "bg-green-400"
                : "bg-yellow-400"
          }`}
          data-testid="claude-status-dot"
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
            {agent.name}
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {!agent.installed
              ? "Not installed"
              : agent.authConfigured
                ? "Authenticated"
                : "Not authenticated"}
          </p>
        </div>
      </div>

      {/* Login button (when needs auth and no OAuth URL yet) */}
      {needsAuth && !authUrl && (
        <div className="space-y-2">
          <button
            onClick={handleStartAuth}
            disabled={authPending}
            className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="claude-start-auth"
          >
            {authPending ? "Waiting for login..." : "Login with Claude"}
          </button>
        </div>
      )}

      {/* OAuth flow (when needs auth and authUrl is set) */}
      {needsAuth && authUrl && (
        <div className="space-y-3" data-testid="claude-oauth-flow">
          <a
            href={authUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors text-center"
            data-testid="claude-open-auth-url"
          >
            Open Authentication Page
          </a>
          <div className="space-y-2">
            <label className="block text-xs text-gray-500 dark:text-gray-400">
              After signing in, paste the authorization code:
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={authCode}
                onChange={(e) => setAuthCode(e.target.value)}
                placeholder="Paste code here..."
                className="flex-1 rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 px-4 py-2.5 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 font-mono"
                data-testid="claude-auth-code-input"
              />
              <button
                onClick={handlePasteAuthCode}
                disabled={!authCode.trim()}
                className="rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                data-testid="claude-auth-code-submit"
              >
                Submit
              </button>
            </div>
          </div>
        </div>
      )}

      {/* API key input */}
      {showApiKeyInput && (
        <div className="space-y-2">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {agent.authConfigured ? "Override authentication with an API key:" : "Or authenticate with an API key:"}
          </p>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => { setApiKey(e.target.value); setApiKeyError(""); }}
            onKeyDown={handleApiKeyKeyDown}
            placeholder="sk-ant-..."
            className="w-full rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 px-4 py-3 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 font-mono"
            disabled={apiKeyLoading}
            data-testid="claude-api-key-input"
          />
          {apiKeyError && <p className="text-xs text-red-500" data-testid="claude-api-key-error">{apiKeyError}</p>}
          <button
            onClick={handleApiKeySubmit}
            disabled={!apiKey.trim() || apiKeyLoading}
            className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="claude-api-key-submit"
          >
            Set API Key
          </button>
        </div>
      )}

      {/* Clear API key (Settings-only) */}
      {agent.authConfigured && onClearApiKey && (
        <button
          onClick={onClearApiKey}
          className="w-full px-3 py-2 text-sm rounded-md border bg-gray-50 dark:bg-gray-800 border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          data-testid="claude-clear-api-key"
        >
          Clear API Key
        </button>
      )}
    </div>
  );
}
