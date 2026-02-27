import { useState } from "react";
import type { AgentOption } from "./AgentPicker.js";

export interface CodexAuthCardProps {
  agent: AgentOption | undefined;
  onApiKeySubmit: (key: string) => Promise<boolean | void>;
}

export function CodexAuthCard({ agent, onApiKeySubmit }: CodexAuthCardProps) {
  const [codexKey, setCodexKey] = useState("");
  const [codexKeyError, setCodexKeyError] = useState("");
  const [codexKeyLoading, setCodexKeyLoading] = useState(false);

  if (!agent) return null;

  const handleSubmit = async () => {
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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && codexKey.trim()) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="space-y-3" data-testid="codex-auth-card">
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
          data-testid="codex-status-dot"
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
                : "API key not set"}
          </p>
        </div>
      </div>

      {/* API key input */}
      {agent.installed && !agent.authConfigured && (
        <div className="space-y-2">
          <input
            type="password"
            value={codexKey}
            onChange={(e) => { setCodexKey(e.target.value); setCodexKeyError(""); }}
            onKeyDown={handleKeyDown}
            placeholder="OPENAI_API_KEY"
            className="w-full rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 px-4 py-3 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 font-mono"
            disabled={codexKeyLoading}
            data-testid="codex-api-key-input"
          />
          {codexKeyError && <p className="text-xs text-red-500" data-testid="codex-api-key-error">{codexKeyError}</p>}
          <button
            onClick={handleSubmit}
            disabled={!codexKey.trim() || codexKeyLoading}
            className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="codex-api-key-submit"
          >
            Save
          </button>
        </div>
      )}
    </div>
  );
}
