import { useState } from "react";
import type { AgentOption } from "./AgentPicker.js";
import { ClaudeAuthCard } from "./ClaudeAuthCard.js";
import { CodexAuthCard } from "./CodexAuthCard.js";
import { GitHubTokenForm } from "./GitHubTokenForm.js";

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
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  // Step 2 state
  const [refreshing, setRefreshing] = useState(false);
  const [completing, setCompleting] = useState(false);

  // Step 1 derived
  const canSubmitManual = name.trim().length > 0 && email.trim().length > 0;

  // Step 2 derived
  const claudeAgent = agents.find((a) => a.id === "claude");
  const codexAgent = agents.find((a) => a.id === "codex");
  const anyAgentReady = agents.some((a) => a.installed && a.authConfigured);

  // ---- Step 1 handlers ----

  const handleGitHubTokenSubmit = async (token: string): Promise<boolean | void> => {
    const success = await onGitHubTokenSubmit(token);
    if (success) {
      setStep(2);
    }
    return success;
  };

  const handleManualSubmit = () => {
    if (canSubmitManual) {
      onGitIdentitySubmit(name.trim(), email.trim());
      setStep(2);
    }
  };

  const handleManualKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && canSubmitManual) {
      e.preventDefault();
      handleManualSubmit();
    }
  };

  // ---- Step 2 handlers ----

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await onRefreshAgents();
    } catch {
      // ignore
    }
    setRefreshing(false);
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

              <GitHubTokenForm onSubmit={handleGitHubTokenSubmit} />

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
              <ClaudeAuthCard
                agent={claudeAgent}
                authUrl={authUrl}
                onStartAuth={onStartClaudeAuth}
                onApiKeySubmit={onClaudeApiKeySubmit}
                onPasteAuthCode={onPasteAuthCode}
              />

              <CodexAuthCard
                agent={codexAgent}
                onApiKeySubmit={onCodexApiKeySubmit}
              />

              {agents.filter((a) => a.id !== "claude" && a.id !== "codex").map((agent) => (
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
              ))}
            </div>

            <div className="space-y-3">
              <button
                onClick={() => {
                  setCompleting(true);
                  onComplete();
                }}
                disabled={!anyAgentReady || completing}
                className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="get-started"
              >
                {completing ? "Starting..." : "Get Started"}
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
