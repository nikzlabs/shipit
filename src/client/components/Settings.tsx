import { useState, useEffect, useRef } from "react";
import type { AgentOption } from "./AgentPicker.js";
import type { DeployTargetInfo } from "../../server/shared/types.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Modal } from "./ui/modal.js";
import { ClaudeAuthCard } from "./ClaudeAuthCard.js";
import { CodexAuthCard } from "./CodexAuthCard.js";
import { GitHubTokenForm } from "./GitHubTokenForm.js";
import { UtilityModelCard } from "./UtilityModelCard.js";

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
  onStartAuth: () => void;
  onPasteCode: (code: string) => void;
  agentList?: AgentOption[];
  onSetAgentEnv?: (agentId: string, key: string, value: string) => void;
  onFullReset?: () => void;
  gitIdentity: { name: string; email: string };
  onGitIdentitySave: (name: string, email: string) => void;
  maxIdleContainers: number;
  onMaxIdleContainersSave: (n: number) => void;
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
  onStartAuth,
  onPasteCode,
  agentList = [],
  onSetAgentEnv,
  onFullReset,
  gitIdentity,
  onGitIdentitySave,
  maxIdleContainers,
  onMaxIdleContainersSave,
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
  const [confirmingLogout, setConfirmingLogout] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [selectedDeployTarget, setSelectedDeployTarget] = useState<DeployTargetInfo | null>(null);
  const [deployConfigValues, setDeployConfigValues] = useState<Record<string, string>>({});
  const [savingDeployConfig, setSavingDeployConfig] = useState(false);
  const [deployProjectName, setDeployProjectName] = useState("");
  const [gitName, setGitName] = useState(gitIdentity.name);
  const [gitEmail, setGitEmail] = useState(gitIdentity.email);
  const [gitSaved, setGitSaved] = useState(false);
  const [idleContainers, setIdleContainers] = useState(maxIdleContainers);
  const [idleContainersSaved, setIdleContainersSaved] = useState(false);
  const savedRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
    }
  }, [activeTab]);

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

  const handleDeployConfigSubmit = (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!selectedDeployTarget || savingDeployConfig) return;
    setSavingDeployConfig(true);
    onDeployConfigure(selectedDeployTarget.id, deployConfigValues, deployProjectName || undefined);
    // onDeployConfigure is sync (sends WS message), reset after brief delay
    setTimeout(() => setSavingDeployConfig(false), 1000);
  };

  const handleDeployBackToList = () => {
    setSelectedDeployTarget(null);
    setDeployConfigValues({});
    setDeployProjectName("");
  };

  const charCount = content.length;
  const isOverLimit = charCount > MAX_LENGTH;

  const claudeAgent = agentList.find((a) => a.id === "claude");
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
    <Modal
      onClose={handleBackdropClick}
      className="rounded-lg border-(--color-border-secondary) max-w-2xl w-full mx-4 flex flex-col h-120"
      data-testid="settings-backdrop"
      onKeyDown={handleKeyDown}
      role="dialog"
      aria-label="Settings"
    >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-(--color-border-secondary)">
          <h2 className="text-lg font-semibold text-(--color-text-primary)">Settings</h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="text-xl leading-none"
            aria-label="Close"
          >
            &times;
          </Button>
        </div>

        {/* Body: sidebar tabs + content */}
        <div className="flex flex-1 min-h-0">
          {/* Left tab sidebar */}
          <nav className="w-40 shrink-0 border-r border-(--color-border-secondary) py-2">
            <div className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-(--color-text-tertiary)">
              General
            </div>
            {generalTabs.map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`w-full text-left px-4 py-2 text-sm transition-colors ${
                  activeTab === tab
                    ? "bg-(--color-bg-secondary) text-(--color-text-primary) font-medium"
                    : "text-(--color-text-secondary) hover:text-(--color-text-primary) hover:bg-(--color-bg-hover)"
                }`}
              >
                {tabLabel(tab)}
              </button>
            ))}

            <div className="px-4 py-1.5 mt-3 text-[10px] font-semibold uppercase tracking-wider text-(--color-text-tertiary)">
              Project
            </div>
            <button
              onClick={() => { if (hasActiveSession) setActiveTab("deploy"); }}
              disabled={!hasActiveSession}
              title={!hasActiveSession ? "Requires active session" : undefined}
              className={`w-full text-left px-4 py-2 text-sm transition-colors ${
                !hasActiveSession
                  ? "text-(--color-text-tertiary) cursor-not-allowed"
                  : activeTab === "deploy"
                    ? "bg-(--color-bg-secondary) text-(--color-text-primary) font-medium"
                    : "text-(--color-text-secondary) hover:text-(--color-text-primary) hover:bg-(--color-bg-hover)"
              }`}
              data-testid="settings-tab-deploy"
            >
              Deploy
            </button>
          </nav>

          {/* Right content area */}
          {activeTab === "agent" && (
            <div className="flex-1 min-w-0 px-5 py-4 flex flex-col gap-4 overflow-y-auto">
              <ClaudeAuthCard
                agent={claudeAgent}
                authUrl={authUrl}
                onStartAuth={onStartAuth}
                onApiKeySubmit={async (key) => { onApiKey(key); }}
                onPasteAuthCode={onPasteCode}
                onClearApiKey={onClearApiKey}
                showApiKeyWhenAuthed
              />

              {codexAgent && (
                <div className="pt-2 border-t border-(--color-border-secondary)">
                  <CodexAuthCard
                    agent={codexAgent}
                    onApiKeySubmit={async (key) => { onSetAgentEnv?.("codex", "OPENAI_API_KEY", key); }}
                  />
                </div>
              )}

              <div className="pt-2 border-t border-(--color-border-secondary)">
                <UtilityModelCard />
              </div>
            </div>
          )}

          {activeTab === "instructions" && (
            <div className="flex-1 min-w-0 px-5 py-4 flex flex-col gap-3 overflow-y-auto">
              <p className="text-sm text-(--color-text-secondary)">
                These instructions are sent to the agent with every message. Use them to define project
                conventions, preferred libraries, or style guidelines.
              </p>

              <textarea
                ref={textareaRef}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="e.g. Always use TypeScript with strict mode. Use Tailwind CSS for styling."
                className="flex-1 min-h-30 w-full bg-(--color-bg-secondary) border border-(--color-border-secondary) rounded-md px-3 py-2 text-sm text-(--color-text-primary) placeholder-(--color-text-tertiary) resize-none focus:outline-none focus:border-(--color-border-focus)"
                data-testid="settings-textarea"
              />

              <div className="flex items-center justify-between text-xs text-(--color-text-secondary)">
                <span>
                  Note: The agent also reads CLAUDE.md from your workspace root automatically.
                </span>
                <span className={isOverLimit ? "text-(--color-error)" : ""}>
                  {charCount.toLocaleString()} / {MAX_LENGTH.toLocaleString()}
                </span>
              </div>

              <div className="flex items-center justify-end gap-2">
                <Button
                  variant="ghost"
                  size="md"
                  onClick={onClose}
                  className="rounded-md"
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="md"
                  onClick={handleSave}
                  disabled={isOverLimit}
                  className="rounded-md"
                  data-testid="settings-save"
                >
                  Save
                </Button>
              </div>
            </div>
          )}

          {activeTab === "github" && (
            <div className="flex-1 min-w-0 px-5 py-4 flex flex-col gap-4 overflow-y-auto">
              {githubStatus.authenticated ? (
                <div className="space-y-4">
                  <div className="flex items-center gap-3 p-3 rounded-lg bg-(--color-bg-secondary) border border-(--color-border-secondary)">
                    <span className="w-2.5 h-2.5 rounded-full bg-(--color-success) shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-(--color-text-primary)">
                        {githubStatus.username ?? "GitHub"}
                      </p>
                      <p className="text-xs text-(--color-text-secondary)">Connected</p>
                    </div>
                  </div>

                  <button
                    onClick={() => {
                      if (confirmingLogout) {
                        setDisconnecting(true);
                        onGitHubLogout();
                        setConfirmingLogout(false);
                      } else {
                        setConfirmingLogout(true);
                      }
                    }}
                    onBlur={() => { if (!disconnecting) setConfirmingLogout(false); }}
                    disabled={disconnecting}
                    className={`w-full px-3 py-2 text-sm rounded-md border transition-colors ${
                      disconnecting
                        ? "bg-(--color-bg-secondary) border-(--color-border-secondary) text-(--color-text-tertiary) opacity-50 cursor-not-allowed"
                        : confirmingLogout
                          ? "bg-(--color-error-subtle) border-(--color-error)/50 text-(--color-error)"
                          : "bg-(--color-bg-secondary) border-(--color-border-secondary) text-(--color-text-secondary) hover:text-(--color-text-primary) hover:bg-(--color-bg-hover)"
                    }`}
                    data-testid="settings-disconnect"
                  >
                    {disconnecting ? "Disconnecting..." : confirmingLogout ? "Click again to disconnect" : "Disconnect"}
                  </button>
                </div>
              ) : (
                <GitHubTokenForm onSubmit={async (t) => { onGitHubTokenSubmit(t); }} />
              )}
            </div>
          )}

          {activeTab === "git" && (
            <div className="flex-1 min-w-0 px-5 py-4 flex flex-col gap-4 overflow-y-auto">
              <div className="space-y-4">
                <p className="text-sm text-(--color-text-secondary)">
                  Git identity used for automatic commits in all sessions.
                </p>

                <div>
                  <label className="block text-sm font-medium text-(--color-text-primary) mb-1">Name</label>
                  <input
                    type="text"
                    value={gitName}
                    onChange={(e) => { setGitName(e.target.value); setGitSaved(false); }}
                    placeholder="Your Name"
                    className="w-full rounded-lg bg-(--color-bg-secondary) border border-(--color-border-secondary) px-4 py-3 text-sm text-(--color-text-primary) placeholder-(--color-text-tertiary) focus:outline-none focus:border-(--color-border-focus)"
                    data-testid="settings-git-name"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-(--color-text-primary) mb-1">Email</label>
                  <input
                    type="email"
                    value={gitEmail}
                    onChange={(e) => { setGitEmail(e.target.value); setGitSaved(false); }}
                    placeholder="you@example.com"
                    className="w-full rounded-lg bg-(--color-bg-secondary) border border-(--color-border-secondary) px-4 py-3 text-sm text-(--color-text-primary) placeholder-(--color-text-tertiary) focus:outline-none focus:border-(--color-border-focus)"
                    data-testid="settings-git-email"
                  />
                </div>

                <Button
                  variant="primary"
                  size="lg"
                  onClick={() => {
                    onGitIdentitySave(gitName.trim(), gitEmail.trim());
                    setGitSaved(true);
                  }}
                  disabled={!gitName.trim() || !gitEmail.trim()}
                  className="w-full rounded-lg"
                  data-testid="settings-git-save"
                >
                  {gitSaved ? "Saved" : "Save"}
                </Button>
              </div>
            </div>
          )}

          {activeTab === "advanced" && (
            <div className="flex-1 min-w-0 px-5 py-4 flex flex-col gap-4 overflow-y-auto">
              <div className="space-y-3">
                <h3 className="text-sm font-medium text-(--color-text-primary)">Max Idle Containers</h3>
                <p className="text-sm text-(--color-text-secondary)">
                  Maximum Docker containers kept running when not in use. Containers beyond this limit are stopped. Set to 0 to stop all idle containers immediately.
                </p>
                <div className="flex items-center gap-3">
                  <input
                    type="number"
                    min={0}
                    value={idleContainers}
                    onChange={(e) => { setIdleContainers(Math.max(0, Math.floor(Number(e.target.value) || 0))); setIdleContainersSaved(false); }}
                    className="w-24 rounded-lg bg-(--color-bg-secondary) border border-(--color-border-secondary) px-3 py-2 text-sm text-(--color-text-primary) focus:outline-none focus:border-(--color-border-focus)"
                    data-testid="settings-max-idle-containers"
                  />
                  <Button
                    variant="primary"
                    size="md"
                    onClick={() => { onMaxIdleContainersSave(idleContainers); setIdleContainersSaved(true); }}
                    className="rounded-md"
                    data-testid="settings-max-idle-containers-save"
                  >
                    {idleContainersSaved ? "Saved" : "Save"}
                  </Button>
                </div>
              </div>

              <div className="border-t border-(--color-border-secondary)" />

              <div className="space-y-4">
                <h3 className="text-sm font-medium text-(--color-text-primary)">Reset Container</h3>
                <p className="text-sm text-(--color-text-secondary)">
                  Delete all sessions, chat history, and settings. Credentials (GitHub, Claude) are preserved. This cannot be undone.
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
                      ? "bg-(--color-error-subtle) border-(--color-error)/50 text-(--color-error) opacity-50 cursor-not-allowed"
                      : confirmingReset
                        ? "bg-(--color-error-subtle) border-(--color-error)/50 text-(--color-error)"
                        : "bg-(--color-error-subtle) border-(--color-error)/30 text-(--color-error) hover:border-(--color-error)/50"
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
                    <Button
                      variant="ghost"
                      size="sm"
                      type="button"
                      onClick={handleDeployBackToList}
                      className="text-(--color-text-tertiary)"
                      aria-label="Back to targets"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                      </svg>
                    </Button>
                    <h3 className="text-sm font-medium text-(--color-text-primary)">
                      Configure {selectedDeployTarget.name}
                    </h3>
                  </div>

                  {selectedDeployTarget.configFields.map((field) => (
                    <div key={field.key}>
                      <label className="block text-sm font-medium text-(--color-text-primary) mb-1">
                        {field.label}
                        {field.required && <span className="text-(--color-error) ml-0.5">*</span>}
                      </label>
                      <input
                        type={field.sensitive ? "password" : "text"}
                        placeholder={field.placeholder}
                        value={deployConfigValues[field.key] || ""}
                        onChange={(e) =>
                          setDeployConfigValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                        }
                        className="w-full px-3 py-2 rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) text-(--color-text-primary) text-sm focus:outline-none focus:ring-2 focus:ring-(--color-accent)"
                        required={field.required}
                        autoComplete="off"
                        data-testid={`deploy-config-field-${field.key}`}
                      />
                      {field.helpText && (
                        <p className="text-xs text-(--color-text-secondary) mt-1">{field.helpText}</p>
                      )}
                      {field.helpUrl && (
                        <a
                          href={field.helpUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-(--color-text-link) hover:text-(--color-accent) mt-1 inline-block"
                        >
                          Get credentials &rarr;
                        </a>
                      )}
                    </div>
                  ))}

                  <div>
                    <label className="block text-sm font-medium text-(--color-text-primary) mb-1">
                      Project Name <span className="text-(--color-text-tertiary) font-normal">(optional)</span>
                    </label>
                    <input
                      type="text"
                      placeholder="Auto-generated from directory name"
                      value={deployProjectName}
                      onChange={(e) => setDeployProjectName(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) text-(--color-text-primary) text-sm focus:outline-none focus:ring-2 focus:ring-(--color-accent)"
                      data-testid="deploy-config-project-name"
                    />
                  </div>

                  <Button
                    variant="primary"
                    size="lg"
                    type="submit"
                    disabled={savingDeployConfig}
                    className="w-full rounded-lg"
                    data-testid="deploy-config-save"
                  >
                    {savingDeployConfig ? "Saving..." : "Save Configuration"}
                  </Button>
                </form>
              ) : (
                <div className="space-y-3" data-testid="deploy-target-list">
                  <h3 className="text-sm font-medium text-(--color-text-primary) mb-2">Deploy Targets</h3>
                  {deployTargets.length === 0 ? (
                    <p className="text-sm text-(--color-text-secondary)">No deployment targets available.</p>
                  ) : (
                    deployTargets.map((target) => {
                      const status = deployConfigStatus[target.id];
                      return (
                        <div
                          key={target.id}
                          className="p-4 rounded-lg border border-(--color-border-secondary)"
                          data-testid={`deploy-target-${target.id}`}
                        >
                          <div className="flex items-center justify-between">
                            <div>
                              <div className="font-medium text-(--color-text-primary)">{target.name}</div>
                              <div className="text-sm text-(--color-text-secondary) mt-0.5">{target.description}</div>
                            </div>
                            {status?.configured && (
                              <Badge variant="success">Configured</Badge>
                            )}
                          </div>
                          <div className="flex gap-2 mt-3">
                            <button
                              onClick={() => {
                                setSelectedDeployTarget(target);
                                setDeployConfigValues({});
                                setDeployProjectName(status?.projectName ?? "");
                              }}
                              className="text-xs text-(--color-text-link) hover:text-(--color-accent) transition-colors"
                              data-testid={`deploy-target-configure-${target.id}`}
                            >
                              {status?.configured ? "Reconfigure" : "Configure"}
                            </button>
                            {status?.configured && (
                              <>
                                <span className="text-(--color-text-tertiary) text-xs">|</span>
                                <button
                                  onClick={() => onDeployDeleteConfig(target.id)}
                                  className="text-xs text-(--color-error) hover:text-(--color-error) transition-colors"
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
    </Modal>
  );
}
