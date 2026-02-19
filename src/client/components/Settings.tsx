import { useState, useEffect, useRef } from "react";
import type { AgentOption } from "./AgentPicker.js";
import type { DeployTargetInfo } from "../../server/types.js";

const MAX_LENGTH = 50_000;

type Tab = "agent" | "github" | "git" | "instructions" | "advanced" | "deploy";

export interface SettingsProps {
  initialContent: string;
  onSaveInstructions: (content: string) => void;
  githubStatus: { authenticated: boolean; username?: string; avatarUrl?: string };
  onGitHubTokenSubmit: (token: string) => void;
  onGitHubLogout: () => void;
  authUrl: string | null;
  onApiKey: (key: string) => void;
  onClearApiKey: () => void;
  agentList?: AgentOption[];
  onSetAgentEnv?: (agentId: string, key: string, value: string) => void;
  onFullReset?: () => void;
  gitIdentity: { name: string; email: string };
  onGitIdentitySave: (name: string, email: string) => void;
  deployTargets: DeployTargetInfo[];
  deployConfigStatus: Record<string, { configured: boolean; projectName?: string }>;
  onDeployConfigure: (targetId: string, credentials: Record<string, string>, projectName?: string) => void;
  onDeployDeleteConfig: (targetId: string) => void;
  hasActiveSession: boolean;
  initialTab?: Tab;
  onDeployTabSelected?: () => void;
  onClose: () => void;
}

export function Settings({
  initialContent,
  onSaveInstructions,
  githubStatus,
  onGitHubTokenSubmit,
  onGitHubLogout,
  authUrl,
  onApiKey,
  onClearApiKey,
  agentList = [],
  onSetAgentEnv,
  onFullReset,
  gitIdentity,
  onGitIdentitySave,
  deployTargets,
  deployConfigStatus,
  onDeployConfigure,
  onDeployDeleteConfig,
  hasActiveSession,
  initialTab,
  onDeployTabSelected,
  onClose,
}: SettingsProps) {
  const [activeTab, setActiveTab] = useState<Tab>(initialTab ?? "agent");
  const [content, setContent] = useState(initialContent);
  const [token, setToken] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyError, setApiKeyError] = useState("");
  const [codexKey, setCodexKey] = useState("");
  const [confirmingLogout, setConfirmingLogout] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [selectedDeployTarget, setSelectedDeployTarget] = useState<DeployTargetInfo | null>(null);
  const [deployConfigValues, setDeployConfigValues] = useState<Record<string, string>>({});
  const [deployProjectName, setDeployProjectName] = useState("");
  const [gitName, setGitName] = useState(gitIdentity.name);
  const [gitEmail, setGitEmail] = useState(gitIdentity.email);
  const [gitSaved, setGitSaved] = useState(false);
  const savedRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const tokenInputRef = useRef<HTMLInputElement>(null);
  const apiKeyInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (activeTab === "deploy") {
      onDeployTabSelected?.();
    }
  }, [activeTab]);

  useEffect(() => {
    setGitName(gitIdentity.name);
    setGitEmail(gitIdentity.email);
  }, [gitIdentity.name, gitIdentity.email]);

  useEffect(() => {
    if (activeTab === "instructions") {
      textareaRef.current?.focus();
    } else if (activeTab === "github" && !githubStatus.authenticated) {
      tokenInputRef.current?.focus();
    } else if (activeTab === "agent" && authUrl !== null) {
      apiKeyInputRef.current?.focus();
    }
  }, [activeTab, githubStatus.authenticated, authUrl]);

  const handleSave = () => {
    savedRef.current = true;
    onSaveInstructions(content);
  };

  const handleBackdropClick = () => {
    if (!savedRef.current) {
      onClose();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
    if (activeTab === "instructions" && e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSave();
    }
  };

  const handleTokenSubmit = () => {
    const trimmed = token.trim();
    if (trimmed) {
      onGitHubTokenSubmit(trimmed);
    }
  };

  const handleTokenKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleTokenSubmit();
    }
  };

  const handleApiKeySubmit = () => {
    const trimmed = apiKey.trim();
    if (!trimmed) return;
    if (!trimmed.startsWith("sk-ant-")) {
      setApiKeyError("API key must start with sk-ant-");
      return;
    }
    setApiKeyError("");
    onApiKey(trimmed);
  };

  const handleApiKeyKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleApiKeySubmit();
    }
  };

  const handleCodexKeySubmit = () => {
    const trimmed = codexKey.trim();
    if (!trimmed) return;
    onSetAgentEnv?.("codex", "OPENAI_API_KEY", trimmed);
    setCodexKey("");
  };

  const handleCodexKeyKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleCodexKeySubmit();
    }
  };

  const handleDeployConfigSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedDeployTarget) return;
    onDeployConfigure(selectedDeployTarget.id, deployConfigValues, deployProjectName || undefined);
  };

  const handleDeployBackToList = () => {
    setSelectedDeployTarget(null);
    setDeployConfigValues({});
    setDeployProjectName("");
  };

  const charCount = content.length;
  const isOverLimit = charCount > MAX_LENGTH;

  const codexAgent = agentList.find((a) => a.id === "codex");

  const generalTabs = ["agent", "github", "git", "instructions", "advanced"] as const;
  const tabLabel = (tab: Tab) => {
    switch (tab) {
      case "agent": return "Agent";
      case "github": return "GitHub";
      case "git": return "Git";
      case "instructions": return "Instructions";
      case "advanced": return "Advanced";
      case "deploy": return "Deploy";
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={handleBackdropClick}
      data-testid="settings-backdrop"
    >
      <div
        className="bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg shadow-xl max-w-2xl w-full mx-4 flex flex-col h-120"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        role="dialog"
        aria-label="Settings"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-300 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Settings</h2>
          <button
            onClick={onClose}
            className="text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 transition-colors text-xl leading-none"
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        {/* Body: sidebar tabs + content */}
        <div className="flex flex-1 min-h-0">
          {/* Left tab sidebar */}
          <nav className="w-40 shrink-0 border-r border-gray-200 dark:border-gray-700 py-2">
            <div className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
              General
            </div>
            {generalTabs.map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`w-full text-left px-4 py-2 text-sm transition-colors ${
                  activeTab === tab
                    ? "bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100 font-medium"
                    : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800/50"
                }`}
              >
                {tabLabel(tab)}
              </button>
            ))}

            <div className="px-4 py-1.5 mt-3 text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
              Project
            </div>
            <button
              onClick={() => { if (hasActiveSession) setActiveTab("deploy"); }}
              disabled={!hasActiveSession}
              title={!hasActiveSession ? "Requires active session" : undefined}
              className={`w-full text-left px-4 py-2 text-sm transition-colors ${
                !hasActiveSession
                  ? "text-gray-300 dark:text-gray-600 cursor-not-allowed"
                  : activeTab === "deploy"
                    ? "bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100 font-medium"
                    : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800/50"
              }`}
              data-testid="settings-tab-deploy"
            >
              Deploy
            </button>
          </nav>

          {/* Right content area */}
          {activeTab === "agent" && (
            <div className="flex-1 min-w-0 px-5 py-4 flex flex-col gap-4 overflow-y-auto">
              {authUrl === null ? (
                <div className="space-y-4">
                  <div className="flex items-center gap-3 p-3 rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700">
                    <span className="w-2.5 h-2.5 rounded-full bg-green-400 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                        Claude CLI
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">Authenticated</p>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <p className="text-sm text-gray-600 dark:text-gray-400">
                      Override authentication with an API key:
                    </p>
                    <input
                      ref={apiKeyInputRef}
                      type="password"
                      value={apiKey}
                      onChange={(e) => { setApiKey(e.target.value); setApiKeyError(""); }}
                      onKeyDown={handleApiKeyKeyDown}
                      placeholder="sk-ant-..."
                      className="w-full rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 px-4 py-3 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 font-mono"
                      data-testid="settings-api-key-input"
                    />
                    {apiKeyError && <p className="text-xs text-red-500" data-testid="settings-api-key-error">{apiKeyError}</p>}
                    <button
                      onClick={handleApiKeySubmit}
                      disabled={!apiKey.trim()}
                      className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      data-testid="settings-api-key-submit"
                    >
                      Set API Key
                    </button>
                  </div>

                  <button
                    onClick={onClearApiKey}
                    className="w-full px-3 py-2 text-sm rounded-md border bg-gray-50 dark:bg-gray-800 border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                    data-testid="settings-clear-api-key"
                  >
                    Clear API Key
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex items-center gap-3 p-3 rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700">
                    <span className="w-2.5 h-2.5 rounded-full bg-yellow-400 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                        Claude CLI
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">Authentication required</p>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <p className="text-sm text-gray-600 dark:text-gray-400">
                      Enter your Anthropic API key to authenticate:
                    </p>
                    <input
                      ref={apiKeyInputRef}
                      type="password"
                      value={apiKey}
                      onChange={(e) => { setApiKey(e.target.value); setApiKeyError(""); }}
                      onKeyDown={handleApiKeyKeyDown}
                      placeholder="sk-ant-..."
                      className="w-full rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 px-4 py-3 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 font-mono"
                      data-testid="settings-api-key-input"
                    />
                    {apiKeyError && <p className="text-xs text-red-500" data-testid="settings-api-key-error">{apiKeyError}</p>}
                    <button
                      onClick={handleApiKeySubmit}
                      disabled={!apiKey.trim()}
                      className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      data-testid="settings-api-key-submit"
                    >
                      Authenticate
                    </button>
                  </div>
                </div>
              )}

              {/* Codex agent section */}
              {codexAgent && (
                <div className="space-y-2 pt-2 border-t border-gray-200 dark:border-gray-700" data-testid="codex-agent-section">
                  <div className="flex items-center gap-3 p-3 rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700">
                    <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                      !codexAgent.installed ? "bg-gray-400" : codexAgent.authConfigured ? "bg-green-400" : "bg-yellow-400"
                    }`} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                        Codex
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {!codexAgent.installed
                          ? "Not installed"
                          : codexAgent.authConfigured
                            ? "Authenticated"
                            : "API key not set"}
                      </p>
                    </div>
                  </div>

                  {codexAgent.installed && !codexAgent.authConfigured && (
                    <div className="space-y-2">
                      <input
                        type="password"
                        value={codexKey}
                        onChange={(e) => setCodexKey(e.target.value)}
                        onKeyDown={handleCodexKeyKeyDown}
                        placeholder="OPENAI_API_KEY"
                        className="w-full rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 px-4 py-3 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 font-mono"
                        data-testid="codex-api-key-input"
                      />
                      <button
                        onClick={handleCodexKeySubmit}
                        disabled={!codexKey.trim()}
                        className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        data-testid="codex-api-key-submit"
                      >
                        Save
                      </button>
                    </div>
                  )}
                </div>
              )}

            </div>
          )}

          {activeTab === "instructions" && (
            <div className="flex-1 min-w-0 px-5 py-4 flex flex-col gap-3 overflow-y-auto">
              <p className="text-sm text-gray-600 dark:text-gray-400">
                These instructions are sent to the agent with every message. Use them to define project
                conventions, preferred libraries, or style guidelines.
              </p>

              <textarea
                ref={textareaRef}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="e.g. Always use TypeScript with strict mode. Use Tailwind CSS for styling."
                className="flex-1 min-h-30 w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-md px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-500 resize-none focus:outline-none focus:border-blue-500"
                data-testid="settings-textarea"
              />

              <div className="flex items-center justify-between text-xs text-gray-500">
                <span>
                  Note: The agent also reads CLAUDE.md from your workspace root automatically.
                </span>
                <span className={isOverLimit ? "text-red-400" : ""}>
                  {charCount.toLocaleString()} / {MAX_LENGTH.toLocaleString()}
                </span>
              </div>

              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={onClose}
                  className="px-3 py-1.5 text-sm rounded-md text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={isOverLimit}
                  className="px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  data-testid="settings-save"
                >
                  Save
                </button>
              </div>
            </div>
          )}

          {activeTab === "github" && (
            <div className="flex-1 min-w-0 px-5 py-4 flex flex-col gap-4 overflow-y-auto">
              {githubStatus.authenticated ? (
                <div className="space-y-4">
                  <div className="flex items-center gap-3 p-3 rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700">
                    <span className="w-2.5 h-2.5 rounded-full bg-green-400 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                        {githubStatus.username ?? "GitHub"}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">Connected</p>
                    </div>
                  </div>

                  <button
                    onClick={() => {
                      if (confirmingLogout) {
                        onGitHubLogout();
                        setConfirmingLogout(false);
                      } else {
                        setConfirmingLogout(true);
                      }
                    }}
                    onBlur={() => setConfirmingLogout(false)}
                    className={`w-full px-3 py-2 text-sm rounded-md border transition-colors ${
                      confirmingLogout
                        ? "bg-red-50 dark:bg-red-900/30 border-red-300 dark:border-red-700 text-red-700 dark:text-red-300"
                        : "bg-gray-50 dark:bg-gray-800 border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700"
                    }`}
                    data-testid="settings-disconnect"
                  >
                    {confirmingLogout ? "Click again to disconnect" : "Disconnect"}
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    Enter a <strong className="text-gray-700 dark:text-gray-300">classic</strong> Personal Access Token with
                    the <code className="text-xs bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded">repo</code> scope.
                    Fine-grained tokens are not supported.
                  </p>

                  <input
                    ref={tokenInputRef}
                    type="password"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    onKeyDown={handleTokenKeyDown}
                    placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                    className="w-full rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 px-4 py-3 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 font-mono"
                    data-testid="settings-token-input"
                  />

                  <button
                    onClick={handleTokenSubmit}
                    disabled={!token.trim()}
                    className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    data-testid="settings-connect"
                  >
                    Connect
                  </button>

                  <p className="text-xs text-gray-500">
                    Your token is stored locally and never shared. Create one at{" "}
                    <a
                      href="https://github.com/settings/tokens/new"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-400 hover:text-blue-300"
                    >
                      GitHub Settings
                    </a>.
                  </p>
                </div>
              )}
            </div>
          )}

          {activeTab === "git" && (
            <div className="flex-1 min-w-0 px-5 py-4 flex flex-col gap-4 overflow-y-auto">
              <div className="space-y-4">
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  Git identity used for automatic commits in all sessions.
                </p>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Name</label>
                  <input
                    type="text"
                    value={gitName}
                    onChange={(e) => { setGitName(e.target.value); setGitSaved(false); }}
                    placeholder="Your Name"
                    className="w-full rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 px-4 py-3 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
                    data-testid="settings-git-name"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Email</label>
                  <input
                    type="email"
                    value={gitEmail}
                    onChange={(e) => { setGitEmail(e.target.value); setGitSaved(false); }}
                    placeholder="you@example.com"
                    className="w-full rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 px-4 py-3 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
                    data-testid="settings-git-email"
                  />
                </div>

                <button
                  onClick={() => {
                    onGitIdentitySave(gitName.trim(), gitEmail.trim());
                    setGitSaved(true);
                  }}
                  disabled={!gitName.trim() || !gitEmail.trim()}
                  className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  data-testid="settings-git-save"
                >
                  {gitSaved ? "Saved" : "Save"}
                </button>
              </div>
            </div>
          )}

          {activeTab === "advanced" && (
            <div className="flex-1 min-w-0 px-5 py-4 flex flex-col gap-4 overflow-y-auto">
              <div className="space-y-4">
                <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">Reset Container</h3>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  Delete all sessions, chat history, credentials, and settings. This cannot be undone.
                </p>
                <button
                  onClick={() => {
                    if (confirmingReset) {
                      setResetting(true);
                      onFullReset?.();
                    } else {
                      setConfirmingReset(true);
                    }
                  }}
                  onBlur={() => {
                    if (!resetting) setConfirmingReset(false);
                  }}
                  disabled={resetting}
                  className={`w-full px-3 py-2 text-sm rounded-md border transition-colors ${
                    resetting
                      ? "bg-red-50 dark:bg-red-900/30 border-red-300 dark:border-red-700 text-red-700 dark:text-red-300 opacity-50 cursor-not-allowed"
                      : confirmingReset
                        ? "bg-red-50 dark:bg-red-900/30 border-red-300 dark:border-red-700 text-red-700 dark:text-red-300"
                        : "bg-red-50 dark:bg-red-900/20 border-red-300 dark:border-red-800 text-red-700 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/40"
                  }`}
                  data-testid="settings-reset"
                >
                  {resetting ? "Resetting..." : confirmingReset ? "Click again to confirm reset" : "Reset Everything"}
                </button>
              </div>
            </div>
          )}

          {activeTab === "deploy" && (
            <div className="flex-1 min-w-0 px-5 py-4 flex flex-col gap-4 overflow-y-auto">
              {selectedDeployTarget ? (
                <form onSubmit={handleDeployConfigSubmit} className="space-y-4" data-testid="deploy-config-form">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleDeployBackToList}
                      className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                      aria-label="Back to targets"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                      </svg>
                    </button>
                    <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      Configure {selectedDeployTarget.name}
                    </h3>
                  </div>

                  {selectedDeployTarget.configFields.map((field) => (
                    <div key={field.key}>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                        {field.label}
                        {field.required && <span className="text-red-500 ml-0.5">*</span>}
                      </label>
                      <input
                        type={field.sensitive ? "password" : "text"}
                        placeholder={field.placeholder}
                        value={deployConfigValues[field.key] || ""}
                        onChange={(e) =>
                          setDeployConfigValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                        }
                        className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        required={field.required}
                        autoComplete="off"
                        data-testid={`deploy-config-field-${field.key}`}
                      />
                      {field.helpText && (
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{field.helpText}</p>
                      )}
                      {field.helpUrl && (
                        <a
                          href={field.helpUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-blue-500 hover:text-blue-400 mt-1 inline-block"
                        >
                          Get credentials &rarr;
                        </a>
                      )}
                    </div>
                  ))}

                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      Project Name <span className="text-gray-400 font-normal">(optional)</span>
                    </label>
                    <input
                      type="text"
                      placeholder="Auto-generated from directory name"
                      value={deployProjectName}
                      onChange={(e) => setDeployProjectName(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      data-testid="deploy-config-project-name"
                    />
                  </div>

                  <button
                    type="submit"
                    className="w-full px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-500 transition-colors font-medium"
                    data-testid="deploy-config-save"
                  >
                    Save Configuration
                  </button>
                </form>
              ) : (
                <div className="space-y-3" data-testid="deploy-target-list">
                  <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Deploy Targets</h3>
                  {deployTargets.length === 0 ? (
                    <p className="text-sm text-gray-500 dark:text-gray-400">No deployment targets available.</p>
                  ) : (
                    deployTargets.map((target) => {
                      const status = deployConfigStatus[target.id];
                      return (
                        <div
                          key={target.id}
                          className="p-4 rounded-lg border border-gray-200 dark:border-gray-700"
                          data-testid={`deploy-target-${target.id}`}
                        >
                          <div className="flex items-center justify-between">
                            <div>
                              <div className="font-medium text-gray-900 dark:text-gray-100">{target.name}</div>
                              <div className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{target.description}</div>
                            </div>
                            {status?.configured && (
                              <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300">
                                Configured
                              </span>
                            )}
                          </div>
                          <div className="flex gap-2 mt-3">
                            <button
                              onClick={() => {
                                setSelectedDeployTarget(target);
                                setDeployConfigValues({});
                                setDeployProjectName(status?.projectName ?? "");
                              }}
                              className="text-xs text-blue-500 hover:text-blue-400 transition-colors"
                              data-testid={`deploy-target-configure-${target.id}`}
                            >
                              {status?.configured ? "Reconfigure" : "Configure"}
                            </button>
                            {status?.configured && (
                              <>
                                <span className="text-gray-400 text-xs">|</span>
                                <button
                                  onClick={() => onDeployDeleteConfig(target.id)}
                                  className="text-xs text-red-500 hover:text-red-400 transition-colors"
                                  data-testid={`deploy-target-remove-${target.id}`}
                                >
                                  Remove credentials
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
