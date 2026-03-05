import { useState } from "react";
import { CircleNotchIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";

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

  const handleCodeSubmit = (e: React.SyntheticEvent<HTMLFormElement>) => {
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

  const handleApiKeySubmit = (e: React.SyntheticEvent<HTMLFormElement>) => {
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-(--color-bg-overlay) backdrop-blur-sm">
      <div className="max-w-md w-full mx-4 rounded-xl bg-(--color-bg-elevated) border border-(--color-border-secondary) p-8 text-center space-y-6">
        <div className="space-y-2">
          <div className="text-3xl">&#128274;</div>
          <h2 className="text-xl font-semibold text-(--color-text-primary)">
            Authentication Required
          </h2>
          <p className="text-sm text-(--color-text-secondary)">
            Claude Code CLI needs to authenticate with your Anthropic account.
          </p>
        </div>

        {hasUrl ? (
          <>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block rounded-lg bg-(--color-accent) px-6 py-3 text-sm font-medium text-(--color-accent-text) hover:bg-(--color-accent-hover) transition-colors"
            >
              Open Authentication Page
            </a>

            <div className="pt-4 border-t border-(--color-border-primary)">
              <form onSubmit={handleCodeSubmit} className="space-y-3">
                <label htmlFor="auth-code" className="block text-sm text-(--color-text-secondary)">
                  After signing in, paste the authorization code below
                </label>
                <input
                  id="auth-code"
                  type="text"
                  value={authCode}
                  onChange={(e) => { setAuthCode(e.target.value); setCodeError(""); }}
                  placeholder="Paste code here..."
                  disabled={codeSubmitted}
                  className="w-full rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) px-4 py-2 text-sm text-(--color-text-primary) placeholder-(--color-text-tertiary) focus:outline-none focus:ring-2 focus:ring-(--color-accent) font-mono disabled:opacity-50"
                />
                {codeError && <p className="text-xs text-(--color-error)">{codeError}</p>}
                <Button
                  type="submit"
                  disabled={codeSubmitted}
                  size="lg"
                  className="w-full rounded-lg"
                >
                  {codeSubmitted ? "Code Submitted — Waiting..." : "Submit Code"}
                </Button>
              </form>
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center gap-2 text-sm text-(--color-text-secondary)">
            <CircleNotchIcon size={ICON_SIZE.SM} className="animate-spin" />
            <span>Waiting for authentication URL...</span>
          </div>
        )}

        {showApiKey ? (
          <div className="pt-2 border-t border-(--color-border-primary)">
            <form onSubmit={handleApiKeySubmit} className="space-y-3">
              <label htmlFor="api-key" className="block text-sm text-(--color-text-secondary)">
                Enter your Anthropic API key
              </label>
              <input
                id="api-key"
                type="password"
                value={apiKey}
                onChange={(e) => { setApiKey(e.target.value); setApiKeyError(""); }}
                placeholder="sk-ant-..."
                className="w-full rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) px-4 py-2 text-sm text-(--color-text-primary) placeholder-(--color-text-tertiary) focus:outline-none focus:ring-2 focus:ring-(--color-accent)"
              />
              {apiKeyError && <p className="text-xs text-(--color-error)">{apiKeyError}</p>}
              <Button
                type="submit"
                size="lg"
                className="w-full rounded-lg"
              >
                Authenticate
              </Button>
            </form>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowApiKey(true)}
            className="text-(--color-text-tertiary) hover:text-(--color-text-secondary)"
          >
            Use API key instead
          </Button>
        )}
      </div>
    </div>
  );
}
