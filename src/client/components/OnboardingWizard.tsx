import { useState } from "react";
import type { AgentOption } from "./AgentPicker.js";

export interface OnboardingWizardProps {
  // Step 1: Git identity
  onGitIdentitySubmit: (name: string, email: string) => void;
  onGitHubTokenSubmit: (token: string) => Promise<boolean>;
  // Step 2: Agent setup
  agents: AgentOption[];
  onClaudeApiKeySubmit: (key: string) => Promise<boolean>;
  onCodexApiKeySubmit: (key: string) => Promise<boolean>;
  onStartClaudeAuth: () => void;
  authUrl: string | null;
  onPasteAuthCode: (code: string) => void;
  onRefreshAgents: () => Promise<void>;
  // Completion
  onComplete: () => void;
  // Skip step 1 if identity is already set
  initialStep?: 1 | 2;
}

function StepDots({ current }: { current: 1 | 2 }) {
  return (
    <div className="flex justify-center gap-2" data-testid="step-dots">
      <span
        className={`w-2 h-2 rounded-full transition-colors ${current >= 1 ? "bg-blue-500" : "bg-gray-400 dark:bg-gray-600"}`}
        data-testid="step-dot-1"
      />
      <span
        className={`w-2 h-2 rounded-full transition-colors ${current >= 2 ? "bg-blue-500" : "bg-gray-400 dark:bg-gray-600"}`}
        data-testid="step-dot-2"
      />
    </div>
  );
}

export function OnboardingWizard({
  onGitIdentitySubmit,
  onGitHubTokenSubmit,
  agents,
  onClaudeApiKeySubmit,
  onCodexApiKeySubmit,
  onStartClaudeAuth,
  authUrl,
  onPasteAuthCode,
  onRefreshAgents,
  onComplete,
  initialStep = 1,
}: OnboardingWizardProps) {
  const [step, setStep] = useState<1 | 2>(initialStep);

  // Step 1 state
  const [mode, setMode] = useState<"github" | "manual">("github");
  const [token, setToken] = useState("");
  const [ghLoading, setGhLoading] = useState(false);
  const [ghError, setGhError] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  // Step 2 state
  const [claudeKey, setClaudeKey] = useState("");
  const [claudeKeyLoading, setClaudeKeyLoading] = useState(false);
  const [claudeKeyError, setClaudeKeyError] = useState("");
  const [codexKey, setCodexKey] = useState("");
  const [codexKeyLoading, setCodexKeyLoading] = useState(false);
  const [codexKeyError, setCodexKeyError] = useState("");
  const [authCode, setAuthCode] = useState("");
  const [authPending, setAuthPending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Step 1 derived
  const canSubmitToken = token.trim().length > 0 && !ghLoading;
  const canSubmitManual = name.trim().length > 0 && email.trim().length > 0;

  // Step 2 derived
  const claudeAgent = agents.find((a) => a.id === "claude");
  const codexAgent = agents.find((a) => a.id === "codex");
  const anyAgentReady = agents.some((a) => a.installed && a.authConfigured);

  // ---- Step 1 handlers ----

  const handleTokenSubmit = async () => {
    if (!canSubmitToken) return;
    setGhLoading(true);
    setGhError("");
    try {
      const success = await onGitHubTokenSubmit(token.trim());
      if (success) {
        setStep(2);
      } else {
        setGhError("Invalid GitHub token. Make sure it's a classic token with the repo scope.");
      }
    } catch {
      setGhError("Failed to connect. Please try again.");
    }
    setGhLoading(false);
  };

  const handleManualSubmit = () => {
    if (canSubmitManual) {
      onGitIdentitySubmit(name.trim(), email.trim());
      setStep(2);
    }
  };

  const handleTokenKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && canSubmitToken) {
      e.preventDefault();
      handleTokenSubmit();
    }
  };

  const handleManualKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && canSubmitManual) {
      e.preventDefault();
      handleManualSubmit();
    }
  };

  // ---- Step 2 handlers ----

  const handleClaudeKeySubmit = async () => {
    if (!claudeKey.trim()) return;
    setClaudeKeyLoading(true);
    setClaudeKeyError("");
    try {
      const ok = await onClaudeApiKeySubmit(claudeKey.trim());
      if (!ok) {
        setClaudeKeyError("Failed to set API key.");
      } else {
        setClaudeKey("");
      }
    } catch {
      setClaudeKeyError("Failed to set API key.");
    }
    setClaudeKeyLoading(false);
  };

  const handleCodexKeySubmit = async () => {
    if (!codexKey.trim()) return;
    setCodexKeyLoading(true);
    setCodexKeyError("");
    try {
      const ok = await onCodexApiKeySubmit(codexKey.trim());
      if (!ok) {
        setCodexKeyError("Failed to set API key.");
      } else {
        setCodexKey("");
      }
    } catch {
      setCodexKeyError("Failed to set API key.");
    }
    setCodexKeyLoading(false);
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await onRefreshAgents();
    } catch {
      // ignore
    }
    setRefreshing(false);
  };

  const handleStartClaudeAuth = () => {
    setAuthPending(true);
    onStartClaudeAuth();
  };

  const handlePasteAuthCode = () => {
    if (authCode.trim()) {
      onPasteAuthCode(authCode.trim());
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 dark:bg-gray-950/90 backdrop-blur-sm">
      <div className="max-w-md w-full mx-4 rounded-xl bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 p-8 space-y-6">
        <StepDots current={step} />

        {step === 1 ? (
          mode === "github" ? (
            <>
              <div className="space-y-2 text-center">
                <div className="flex justify-center mb-3">
                  <svg className="w-10 h-10 text-gray-900 dark:text-gray-100" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                  </svg>
                </div>
                <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                  Connect GitHub
                </h2>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Log in with GitHub to set up your git identity and enable push, pull requests, and more.
                </p>
              </div>

              <div className="space-y-3">
                <input
                  type="password"
                  value={token}
                  onChange={(e) => {
                    setToken(e.target.value);
                    if (ghError) setGhError("");
                  }}
                  onKeyDown={handleTokenKeyDown}
                  placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                  className="w-full rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 px-4 py-3 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 font-mono"
                  autoFocus
                  disabled={ghLoading}
                  data-testid="github-token-input"
                />

                {ghError && (
                  <p className="text-sm text-red-500 dark:text-red-400" data-testid="github-error">
                    {ghError}
                  </p>
                )}

                <button
                  onClick={handleTokenSubmit}
                  disabled={!canSubmitToken}
                  className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  data-testid="github-connect"
                >
                  {ghLoading ? (
                    <>
                      <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      Connecting...
                    </>
                  ) : (
                    "Connect"
                  )}
                </button>

                <p className="text-xs text-gray-500 text-center">
                  Use a{" "}
                  <a
                    href="https://github.com/settings/tokens/new"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 hover:text-blue-300"
                  >
                    classic Personal Access Token
                  </a>{" "}
                  with the <code className="text-xs bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded">repo</code> scope.
                </p>
              </div>

              <div className="text-center">
                <button
                  onClick={() => setMode("manual")}
                  className="text-sm text-gray-500 hover:text-gray-300 transition-colors"
                  data-testid="switch-manual"
                >
                  Set up manually instead
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="space-y-2 text-center">
                <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                  Git Identity
                </h2>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Enter your name and email for git commits.
                </p>
              </div>

              <div className="space-y-3">
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={handleManualKeyDown}
                  placeholder="Your Name"
                  className="w-full rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 px-4 py-3 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
                  autoFocus
                />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={handleManualKeyDown}
                  placeholder="you@example.com"
                  className="w-full rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 px-4 py-3 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
                />
                <button
                  onClick={handleManualSubmit}
                  disabled={!canSubmitManual}
                  className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  data-testid="manual-save"
                >
                  Save
                </button>
              </div>

              <div className="text-center">
                <button
                  onClick={() => setMode("github")}
                  className="text-sm text-gray-500 hover:text-gray-300 transition-colors"
                  data-testid="switch-github"
                >
                  Connect GitHub instead
                </button>
              </div>
            </>
          )
        ) : (
          <>
            <div className="space-y-2 text-center">
              <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                Agent Setup
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Configure at least one coding agent to get started.
              </p>
            </div>

            <div className="space-y-4">
              {/* Claude agent */}
              {claudeAgent && (
                <div className="space-y-3" data-testid="claude-agent-card">
                  <div className="flex items-center gap-3 p-3 rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700">
                    <span
                      className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                        !claudeAgent.installed
                          ? "bg-gray-400"
                          : claudeAgent.authConfigured
                            ? "bg-green-400"
                            : "bg-yellow-400"
                      }`}
                      data-testid="claude-status-dot"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                        {claudeAgent.name}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {!claudeAgent.installed
                          ? "Not installed"
                          : claudeAgent.authConfigured
                            ? "Authenticated"
                            : "Not authenticated"}
                      </p>
                    </div>
                  </div>

                  {claudeAgent.installed && !claudeAgent.authConfigured && !authUrl && (
                    <div className="space-y-2">
                      <button
                        onClick={handleStartClaudeAuth}
                        disabled={authPending}
                        className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        data-testid="claude-start-auth"
                      >
                        {authPending ? "Waiting for login..." : "Login with Claude"}
                      </button>
                      <div className="space-y-2">
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          Or authenticate with an API key:
                        </p>
                        <input
                          type="password"
                          value={claudeKey}
                          onChange={(e) => { setClaudeKey(e.target.value); setClaudeKeyError(""); }}
                          onKeyDown={(e) => { if (e.key === "Enter" && claudeKey.trim()) { e.preventDefault(); handleClaudeKeySubmit(); } }}
                          placeholder="sk-ant-..."
                          className="w-full rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 px-4 py-3 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 font-mono"
                          disabled={claudeKeyLoading}
                          data-testid="claude-api-key-input"
                        />
                        {claudeKeyError && <p className="text-xs text-red-500" data-testid="claude-api-key-error">{claudeKeyError}</p>}
                        <button
                          onClick={handleClaudeKeySubmit}
                          disabled={!claudeKey.trim() || claudeKeyLoading}
                          className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          data-testid="claude-api-key-submit"
                        >
                          Set API Key
                        </button>
                      </div>
                    </div>
                  )}

                  {claudeAgent.installed && !claudeAgent.authConfigured && authUrl && (
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
                </div>
              )}

              {/* Codex agent */}
              {codexAgent && (
                <div className="space-y-3" data-testid="codex-agent-card">
                  <div className="flex items-center gap-3 p-3 rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700">
                    <span
                      className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                        !codexAgent.installed
                          ? "bg-gray-400"
                          : codexAgent.authConfigured
                            ? "bg-green-400"
                            : "bg-yellow-400"
                      }`}
                      data-testid="codex-status-dot"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                        {codexAgent.name}
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
                        onChange={(e) => { setCodexKey(e.target.value); setCodexKeyError(""); }}
                        onKeyDown={(e) => { if (e.key === "Enter" && codexKey.trim()) { e.preventDefault(); handleCodexKeySubmit(); } }}
                        placeholder="OPENAI_API_KEY"
                        className="w-full rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 px-4 py-3 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 font-mono"
                        disabled={codexKeyLoading}
                        data-testid="codex-api-key-input"
                      />
                      {codexKeyError && <p className="text-xs text-red-500" data-testid="codex-api-key-error">{codexKeyError}</p>}
                      <button
                        onClick={handleCodexKeySubmit}
                        disabled={!codexKey.trim() || codexKeyLoading}
                        className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        data-testid="codex-api-key-submit"
                      >
                        Save
                      </button>
                    </div>
                  )}
                </div>
              )}

              {agents.filter((a) => a.id !== "claude" && a.id !== "codex").length > 0 && (
                agents.filter((a) => a.id !== "claude" && a.id !== "codex").map((agent) => (
                  <div key={agent.id} className="flex items-center gap-3 p-3 rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700">
                    <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                      !agent.installed ? "bg-gray-400" : agent.authConfigured ? "bg-green-400" : "bg-yellow-400"
                    }`} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{agent.name}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {!agent.installed ? "Not installed" : agent.authConfigured ? "Authenticated" : "Needs auth"}
                      </p>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="space-y-3">
              <button
                onClick={onComplete}
                disabled={!anyAgentReady}
                className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="get-started"
              >
                Get Started
              </button>

              <button
                onClick={handleRefresh}
                disabled={refreshing}
                className="w-full text-sm text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-50"
                data-testid="refresh-agents"
              >
                {refreshing ? "Refreshing..." : "Refresh status"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
