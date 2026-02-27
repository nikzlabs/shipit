import { useState, useEffect } from "react";
import { useApi } from "../hooks/useApi.js";

type Provider = "openai-compatible" | "anthropic";

interface UtilityModelStatus {
  configured: boolean;
  provider?: Provider;
  model?: string;
  baseUrl?: string;
}

const DEFAULT_MODELS: Record<Provider, string> = {
  "openai-compatible": "gpt-4o-mini",
  "anthropic": "claude-haiku-4-5-20251001",
};

export function UtilityModelCard() {
  const api = useApi();
  const [status, setStatus] = useState<UtilityModelStatus>({ configured: false });
  const [editing, setEditing] = useState(false);
  const [provider, setProvider] = useState<Provider>("openai-compatible");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.get<UtilityModelStatus>("/api/settings/utility-model").then(setStatus).catch(() => {});
  }, []);

  const handleSave = async () => {
    setError("");
    setSaving(true);
    try {
      const result = await api.put<UtilityModelStatus>("/api/settings/utility-model", {
        provider,
        apiKey,
        model: model || DEFAULT_MODELS[provider],
        ...(provider === "openai-compatible" ? { baseUrl } : {}),
      });
      setStatus(result);
      setEditing(false);
      setApiKey("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    try {
      await api.del("/api/settings/utility-model");
      setStatus({ configured: false });
    } catch {
      // ignore
    }
  };

  const startEditing = () => {
    setProvider(status.provider ?? "openai-compatible");
    setModel(status.model ?? "");
    setBaseUrl(status.baseUrl ?? "https://api.openai.com/v1");
    setApiKey("");
    setError("");
    setEditing(true);
  };

  if (!editing) {
    return (
      <div className="p-4 rounded-lg border border-gray-200 dark:border-gray-700">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">Utility Model</h3>
          {status.configured && (
            <span className="w-2 h-2 rounded-full bg-green-400 shrink-0" />
          )}
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
          Used for lightweight tasks like auto-naming sessions. Separate from the coding agent.
        </p>
        {status.configured ? (
          <div className="space-y-2">
            <div className="text-xs text-gray-600 dark:text-gray-400">
              <span className="capitalize">{status.provider === "openai-compatible" ? "OpenAI-compatible" : "Anthropic"}</span>
              {" / "}
              <span className="font-mono">{status.model}</span>
            </div>
            <div className="flex gap-2">
              <button
                onClick={startEditing}
                className="text-xs text-blue-500 hover:text-blue-400 transition-colors"
              >
                Reconfigure
              </button>
              <span className="text-gray-400 text-xs">|</span>
              <button
                onClick={handleClear}
                className="text-xs text-red-500 hover:text-red-400 transition-colors"
              >
                Remove
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={startEditing}
            className="text-xs text-blue-500 hover:text-blue-400 transition-colors"
          >
            Configure
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="p-4 rounded-lg border border-gray-200 dark:border-gray-700 space-y-3">
      <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">Utility Model</h3>

      <div>
        <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Provider</label>
        <select
          value={provider}
          onChange={(e) => {
            const p = e.target.value as Provider;
            setProvider(p);
            setModel("");
            if (p === "anthropic") setBaseUrl("");
            else setBaseUrl("https://api.openai.com/v1");
          }}
          className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:border-blue-500"
          data-testid="utility-model-provider"
        >
          <option value="openai-compatible">OpenAI-compatible</option>
          <option value="anthropic">Anthropic</option>
        </select>
      </div>

      {provider === "openai-compatible" && (
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Base URL</label>
          <input
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:border-blue-500"
            data-testid="utility-model-base-url"
          />
          <p className="text-[10px] text-gray-400 mt-1">Works with OpenAI, Groq, Together, OpenRouter, etc.</p>
        </div>
      )}

      <div>
        <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">API Key</label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-..."
          className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:border-blue-500"
          autoComplete="off"
          data-testid="utility-model-api-key"
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Model</label>
        <input
          type="text"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={DEFAULT_MODELS[provider]}
          className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:border-blue-500"
          data-testid="utility-model-name"
        />
      </div>

      {error && <p className="text-xs text-red-500">{error}</p>}

      <div className="flex gap-2">
        <button
          onClick={handleSave}
          disabled={!apiKey.trim() || saving}
          className="flex-1 px-3 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-500 transition-colors font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          data-testid="utility-model-save"
        >
          {saving ? "Saving..." : "Save"}
        </button>
        <button
          onClick={() => setEditing(false)}
          className="px-3 py-2 text-sm rounded-lg text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
