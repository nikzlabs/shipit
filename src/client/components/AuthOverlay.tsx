import { useState } from "react";

interface AuthOverlayProps {
  url: string;
  onPasteCode?: (code: string) => void;
  onApiKey?: (key: string) => void;
}

export function AuthOverlay({ url, onPasteCode, onApiKey }: AuthOverlayProps) {
  const hasUrl = url.length > 0;
  const [authCode, setAuthCode] = useState("");
  const [codeError, setCodeError] = useState("");
  const [codeSubmitted, setCodeSubmitted] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [apiKeyError, setApiKeyError] = useState("");

  const handleCodeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = authCode.trim();
    if (!trimmed) {
      setCodeError("Authorization code cannot be empty");
      return;
    }
    setCodeError("");
    setCodeSubmitted(true);
    onPasteCode?.(trimmed);
  };

  const handleApiKeySubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = apiKey.trim();
    if (!trimmed) {
      setApiKeyError("API key cannot be empty");
      return;
    }
    if (!trimmed.startsWith("sk-ant-")) {
      setApiKeyError("Invalid API key format");
      return;
    }
    setApiKeyError("");
    onApiKey?.(trimmed);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 dark:bg-gray-950/90 backdrop-blur-sm">
      <div className="max-w-md w-full mx-4 rounded-xl bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 p-8 text-center space-y-6">
        <div className="space-y-2">
          <div className="text-3xl">&#128274;</div>
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            Authentication Required
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Claude Code CLI needs to authenticate with your Anthropic account.
          </p>
        </div>

        {hasUrl ? (
          <>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block rounded-lg bg-blue-600 px-6 py-3 text-sm font-medium text-white hover:bg-blue-500 transition-colors"
            >
              Open Authentication Page
            </a>

            <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
              <form onSubmit={handleCodeSubmit} className="space-y-3">
                <label htmlFor="auth-code" className="block text-sm text-gray-500 dark:text-gray-400">
                  After signing in, paste the authorization code below
                </label>
                <input
                  id="auth-code"
                  type="text"
                  value={authCode}
                  onChange={(e) => { setAuthCode(e.target.value); setCodeError(""); }}
                  placeholder="Paste code here..."
                  disabled={codeSubmitted}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono disabled:opacity-50"
                />
                {codeError && <p className="text-xs text-red-500">{codeError}</p>}
                <button
                  type="submit"
                  disabled={codeSubmitted}
                  className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {codeSubmitted ? "Code Submitted — Waiting..." : "Submit Code"}
                </button>
              </form>
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center gap-2 text-sm text-gray-500 dark:text-gray-400">
            <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span>Waiting for authentication URL...</span>
          </div>
        )}

        {showApiKey ? (
          <div className="pt-2 border-t border-gray-200 dark:border-gray-700">
            <form onSubmit={handleApiKeySubmit} className="space-y-3">
              <label htmlFor="api-key" className="block text-sm text-gray-500 dark:text-gray-400">
                Enter your Anthropic API key
              </label>
              <input
                id="api-key"
                type="password"
                value={apiKey}
                onChange={(e) => { setApiKey(e.target.value); setApiKeyError(""); }}
                placeholder="sk-ant-..."
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              {apiKeyError && <p className="text-xs text-red-500">{apiKeyError}</p>}
              <button
                type="submit"
                className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 transition-colors"
              >
                Authenticate
              </button>
            </form>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowApiKey(true)}
            className="text-xs text-gray-400 hover:text-gray-300 transition-colors"
          >
            Use API key instead
          </button>
        )}
      </div>
    </div>
  );
}
