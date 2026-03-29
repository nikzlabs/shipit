import { useState, useRef } from "react";
import type { AgentOption } from "./AgentPicker.js";
import { Button } from "./ui/button.js";
import { Dialog, DialogContent } from "./ui/dialog.js";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs.js";
import { ClaudeAuthCard } from "./ClaudeAuthCard.js";
import { CodexAuthCard } from "./CodexAuthCard.js";
import { GitHubTokenForm } from "./GitHubTokenForm.js";
import { UtilityModelCard } from "./UtilityModelCard.js";
import { useUiStore } from "../stores/ui-store.js";

const MAX_LENGTH = 50_000;

type Tab = "agent" | "github" | "git" | "instructions" | "advanced" | "deployments" | "secrets";

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
  agentSystemInstructionsEnabled: boolean;
  agentSystemInstructions: string;
  onToggleAgentSystemInstructions: (enabled: boolean) => void;
  hasActiveSession: boolean;
  repoUrl?: string;
  onSecretsSave?: (repoUrl: string, secrets: Record<string, string>) => void;
  onSecretsLoad?: (repoUrl: string) => Promise<Record<string, string>>;
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
  agentSystemInstructionsEnabled,
  agentSystemInstructions,
  onToggleAgentSystemInstructions,
  hasActiveSession,
  repoUrl,
  onSecretsSave,
  onSecretsLoad,
  onClose,
}: SettingsProps) {
  const activeTab = useUiStore((s) => s.settingsTab) ?? "agent";
  const setActiveTab = useUiStore((s) => s.setSettingsTab);
  const [content, setContent] = useState(initialContent);
  const [confirmingLogout, setConfirmingLogout] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [gitName, setGitName] = useState(gitIdentity.name);
  const [gitEmail, setGitEmail] = useState(gitIdentity.email);
  const [gitSaved, setGitSaved] = useState(false);
  const [idleContainers, setIdleContainers] = useState(maxIdleContainers);
  const [idleContainersSaved, setIdleContainersSaved] = useState(false);
  const [instructionsExpanded, setInstructionsExpanded] = useState(false);
  const [secretEntries, setSecretEntries] = useState<{ key: string; value: string }[]>([]);
  const [secretsLoaded, setSecretsLoaded] = useState(false);
  const [secretsSaving, setSecretsSaving] = useState(false);
  const [secretsSaved, setSecretsSaved] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<{
    available: boolean; behindBy: number; commitMessages: string[]; currentCommit: string;
  } | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateApplying, setUpdateApplying] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const savedRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load secrets when secrets tab is opened
  const secretsLoadedRef = useRef(false);
  if (activeTab === "secrets" && !secretsLoadedRef.current && repoUrl && onSecretsLoad) {
    secretsLoadedRef.current = true;
    // eslint-disable-next-line no-restricted-syntax -- fire-and-forget in sync render context
    void onSecretsLoad(repoUrl).then((secrets) => {
      const entries = Object.entries(secrets).map(([key, value]) => ({ key, value }));
      setSecretEntries(entries);
      setSecretsLoaded(true);
    }).catch(() => {
      setSecretsLoaded(true);
    });
  }

  // Sync local git identity state when props change (e.g. fetched from server)
  const prevGitIdentityRef = useRef(gitIdentity);
  if (prevGitIdentityRef.current.name !== gitIdentity.name || prevGitIdentityRef.current.email !== gitIdentity.email) {
    prevGitIdentityRef.current = gitIdentity;
    setGitName(gitIdentity.name);
    setGitEmail(gitIdentity.email);
  }

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
      case "deployments": return "Deployments";
      case "secrets": return "Secrets";
    }
  };

  return (
    <Dialog open onOpenChange={(isOpen) => { if (!isOpen) handleBackdropClick(); }}>
      <DialogContent
        className="rounded-lg border-(--color-border-secondary) max-w-2xl w-full mx-4 flex flex-col h-120"
        data-testid="settings-backdrop"
        onKeyDown={handleKeyDown}
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
        <Tabs value={activeTab} onValueChange={(v) => {
          const tab = v as Tab;
          if (tab === "secrets" && !hasActiveSession) return;
          setActiveTab(tab);
          if (tab === "instructions") {
            requestAnimationFrame(() => textareaRef.current?.focus());
          }
        }} className="flex flex-1 min-h-0" orientation="vertical">
          {/* Left tab sidebar */}
          <TabsList className="w-40 shrink-0 border-r border-(--color-border-secondary) py-2">
            <div className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-(--color-text-tertiary)">
              General
            </div>
            {generalTabs.map((tab) => (
              <TabsTrigger key={tab} value={tab}>
                {tabLabel(tab)}
              </TabsTrigger>
            ))}

            <div className="px-4 py-1.5 mt-3 text-[10px] font-semibold uppercase tracking-wider text-(--color-text-tertiary)">
              Project
            </div>
            <TabsTrigger value="deployments" data-testid="settings-tab-deployments">
              Deployments
            </TabsTrigger>
            <TabsTrigger
              value="secrets"
              disabled={!hasActiveSession}
              title={!hasActiveSession ? "Requires active session" : undefined}
              data-testid="settings-tab-secrets"
            >
              Secrets
            </TabsTrigger>
          </TabsList>

          {/* Right content area */}
          <TabsContent value="agent">
            <div className="px-5 py-4 flex flex-col gap-4 overflow-y-auto h-full">
              <ClaudeAuthCard
                agent={claudeAgent}
                authUrl={authUrl}
                onStartAuth={onStartAuth}
                onApiKeySubmit={async (key) => { onApiKey(key); return undefined; }}
                onPasteAuthCode={onPasteCode}
                onClearApiKey={onClearApiKey}
                showApiKeyWhenAuthed
              />

              {codexAgent && (
                <div className="pt-2 border-t border-(--color-border-secondary)">
                  <CodexAuthCard
                    agent={codexAgent}
                    onApiKeySubmit={async (key) => { onSetAgentEnv?.("codex", "OPENAI_API_KEY", key); return undefined; }}
                  />
                </div>
              )}

              <div className="pt-2 border-t border-(--color-border-secondary)">
                <UtilityModelCard />
              </div>
            </div>
          </TabsContent>

          <TabsContent value="instructions">
            <div className="px-5 py-4 flex flex-col gap-3 overflow-y-auto h-full">
              {/* Agent system instructions (built-in) */}
              <div className="rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) p-3 space-y-2" data-testid="agent-system-instructions">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-medium text-(--color-text-primary)">ShipIt Agent Instructions</h3>
                    <p className="text-xs text-(--color-text-tertiary) mt-0.5">
                      Built-in context sent with every message to help the agent understand the ShipIt environment.
                    </p>
                  </div>
                  <button
                    onClick={() => onToggleAgentSystemInstructions(!agentSystemInstructionsEnabled)}
                    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                      agentSystemInstructionsEnabled ? "bg-(--color-accent)" : "bg-(--color-bg-hover)"
                    }`}
                    role="switch"
                    aria-checked={agentSystemInstructionsEnabled}
                    data-testid="agent-instructions-toggle"
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                        agentSystemInstructionsEnabled ? "translate-x-4.5" : "translate-x-0.5"
                      }`}
                    />
                  </button>
                </div>
                {agentSystemInstructions && (
                  <div>
                    <button
                      onClick={() => setInstructionsExpanded(!instructionsExpanded)}
                      className="text-xs text-(--color-text-link) hover:text-(--color-accent) transition-colors"
                      data-testid="agent-instructions-expand"
                    >
                      {instructionsExpanded ? "Hide instructions" : "View instructions"}
                    </button>
                    {instructionsExpanded && (
                      <pre className="mt-2 text-xs text-(--color-text-secondary) whitespace-pre-wrap bg-(--color-bg-primary) rounded-md p-2 border border-(--color-border-secondary) max-h-48 overflow-y-auto" data-testid="agent-instructions-content">
                        {agentSystemInstructions}
                      </pre>
                    )}
                  </div>
                )}
              </div>

              <div className="border-t border-(--color-border-secondary)" />

              {/* User custom instructions */}
              <div>
                <h3 className="text-sm font-medium text-(--color-text-primary) mb-1">Your Instructions</h3>
                <p className="text-xs text-(--color-text-secondary) mb-2">
                  Custom instructions sent to the agent with every message. Use them to define project
                  conventions, preferred libraries, or style guidelines.
                </p>
              </div>

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
          </TabsContent>

          <TabsContent value="github">
            <div className="px-5 py-4 flex flex-col gap-4 overflow-y-auto h-full">
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
                <GitHubTokenForm onSubmit={async (t) => { onGitHubTokenSubmit(t); return undefined; }} />
              )}
            </div>
          </TabsContent>

          <TabsContent value="git">
            <div className="px-5 py-4 flex flex-col gap-4 overflow-y-auto h-full">
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
          </TabsContent>

          <TabsContent value="advanced">
            <div className="px-5 py-4 flex flex-col gap-4 overflow-y-auto h-full">
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

              <div className="space-y-3">
                <h3 className="text-sm font-medium text-(--color-text-primary)">Software Updates</h3>
                <p className="text-sm text-(--color-text-secondary)">
                  Check for new versions and update ShipIt in place.
                </p>
                <div className="flex items-center gap-3">
                  <Button
                    variant="primary"
                    size="md"
                    disabled={updateChecking || updateApplying}
                    onClick={async () => {
                      setUpdateChecking(true);
                      setUpdateError(null);
                      try {
                        const res = await fetch("/api/updates/check", { method: "POST" });
                        if (!res.ok) {
                          const body = await res.json().catch(() => ({})) as { error?: string };
                          throw new Error(body.error ?? `HTTP ${res.status}`);
                        }
                        const data = await res.json() as { available: boolean; behindBy: number; commitMessages: string[]; currentCommit: string };
                        setUpdateStatus(data);
                      } catch (err) {
                        setUpdateError((err as Error).message);
                      } finally {
                        setUpdateChecking(false);
                      }
                    }}
                    className="rounded-md"
                    data-testid="settings-check-updates"
                  >
                    {updateChecking ? "Checking..." : "Check for Updates"}
                  </Button>
                  {updateStatus?.available && !updateApplying && (
                    <Button
                      variant="primary"
                      size="md"
                      onClick={async () => {
                        setUpdateApplying(true);
                        setUpdateError(null);
                        try {
                          const res = await fetch("/api/updates/apply", { method: "POST" });
                          if (!res.ok) {
                            const body = await res.json().catch(() => ({})) as { error?: string };
                            throw new Error(body.error ?? `HTTP ${res.status}`);
                          }
                        } catch (err) {
                          setUpdateApplying(false);
                          setUpdateError((err as Error).message);
                        }
                      }}
                      className="rounded-md"
                      data-testid="settings-apply-update"
                    >
                      Update Now
                    </Button>
                  )}
                </div>
                {updateApplying && (
                  <p className="text-sm text-(--color-text-secondary)">
                    Updating... ShipIt will restart momentarily. Refresh the page in a few seconds.
                  </p>
                )}
                {updateError && (
                  <p className="text-sm text-(--color-error)">{updateError}</p>
                )}
                {updateStatus && !updateApplying && (
                  <div className="text-sm text-(--color-text-secondary)">
                    {updateStatus.available ? (
                      <>
                        <p>{updateStatus.behindBy} update{updateStatus.behindBy === 1 ? "" : "s"} available</p>
                        <ul className="mt-1 ml-4 list-disc space-y-0.5 text-xs font-mono text-(--color-text-tertiary)">
                          {updateStatus.commitMessages.slice(0, 10).map((msg, i) => (
                            <li key={i}>{msg}</li>
                          ))}
                          {updateStatus.behindBy > 10 && <li>...and {updateStatus.behindBy - 10} more</li>}
                        </ul>
                      </>
                    ) : (
                      <p>ShipIt is up to date ({updateStatus.currentCommit.slice(0, 7)})</p>
                    )}
                  </div>
                )}
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
          </TabsContent>

          <TabsContent value="deployments">
            <div className="px-5 py-4 flex flex-col gap-4 overflow-y-auto h-full" data-testid="deployments-tab">
              <div className="space-y-1">
                <h3 className="text-sm font-medium text-(--color-text-primary)">Automatic Deployments</h3>
                <p className="text-xs text-(--color-text-secondary)">
                  Connect your repo to a hosting platform for automatic deploys on every push. ShipIt auto-pushes after every Claude turn, so your site stays in sync.
                </p>
              </div>

              <div className="space-y-3">
                <h4 className="text-xs font-medium text-(--color-text-secondary) uppercase tracking-wider">Connect your repo</h4>
                {[
                  { name: "Vercel", url: "https://vercel.com/new", description: "Best for Next.js, React, and static sites" },
                  { name: "Cloudflare Pages", url: "https://dash.cloudflare.com/?to=/:account/pages/new/provider/github", description: "Fast global CDN with edge functions" },
                  { name: "Netlify", url: "https://app.netlify.com/start", description: "Simple deploys with form handling and functions" },
                ].map((platform) => (
                  <a
                    key={platform.name}
                    href={platform.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block p-3 rounded-lg border border-(--color-border-secondary) hover:border-(--color-border-focus) transition-colors"
                  >
                    <div className="text-sm font-medium text-(--color-text-primary)">{platform.name}</div>
                    <div className="text-xs text-(--color-text-secondary) mt-0.5">{platform.description}</div>
                  </a>
                ))}
              </div>

              <div className="space-y-1 mt-2">
                <h4 className="text-xs font-medium text-(--color-text-secondary) uppercase tracking-wider">How it works</h4>
                <ol className="text-xs text-(--color-text-secondary) space-y-1.5 list-decimal list-inside">
                  <li>Import your GitHub repo on the platform above</li>
                  <li>ShipIt pushes code after every Claude turn</li>
                  <li>The platform builds and deploys automatically</li>
                  <li>Deploy status appears in the PR card</li>
                </ol>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="secrets">
            <div className="px-5 py-4 flex flex-col gap-4 overflow-y-auto h-full" data-testid="secrets-tab">
              <div className="space-y-1">
                <h3 className="text-sm font-medium text-(--color-text-primary)">Environment Variables</h3>
                <p className="text-xs text-(--color-text-secondary)">
                  Secrets are injected into the preview container only. Claude never sees them.
                </p>
              </div>

              {!secretsLoaded ? (
                <p className="text-sm text-(--color-text-tertiary)">Loading...</p>
              ) : (
                <>
                  <div className="space-y-2">
                    {secretEntries.map((entry, idx) => (
                      <div key={idx} className="flex items-center gap-2">
                        <input
                          type="text"
                          value={entry.key}
                          onChange={(e) => {
                            const next = [...secretEntries];
                            next[idx] = { ...next[idx], key: e.target.value };
                            setSecretEntries(next);
                            setSecretsSaved(false);
                          }}
                          placeholder="KEY"
                          className="flex-1 rounded-md bg-(--color-bg-secondary) border border-(--color-border-secondary) px-3 py-2 text-sm text-(--color-text-primary) placeholder-(--color-text-tertiary) focus:outline-none focus:border-(--color-border-focus) font-mono"
                          data-testid={`secret-key-${idx}`}
                        />
                        <input
                          type="password"
                          value={entry.value}
                          onChange={(e) => {
                            const next = [...secretEntries];
                            next[idx] = { ...next[idx], value: e.target.value };
                            setSecretEntries(next);
                            setSecretsSaved(false);
                          }}
                          placeholder="value"
                          className="flex-1 rounded-md bg-(--color-bg-secondary) border border-(--color-border-secondary) px-3 py-2 text-sm text-(--color-text-primary) placeholder-(--color-text-tertiary) focus:outline-none focus:border-(--color-border-focus) font-mono"
                          data-testid={`secret-value-${idx}`}
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setSecretEntries(secretEntries.filter((_, i) => i !== idx));
                            setSecretsSaved(false);
                          }}
                          className="text-(--color-text-tertiary) hover:text-(--color-error) shrink-0"
                          aria-label="Remove secret"
                          data-testid={`secret-remove-${idx}`}
                        >
                          &times;
                        </Button>
                      </div>
                    ))}
                  </div>

                  <button
                    onClick={() => {
                      setSecretEntries([...secretEntries, { key: "", value: "" }]);
                      setSecretsSaved(false);
                    }}
                    className="text-xs text-(--color-text-link) hover:text-(--color-accent) transition-colors self-start"
                    data-testid="secret-add"
                  >
                    + Add variable
                  </button>

                  <div className="flex justify-end mt-2">
                    <Button
                      variant="primary"
                      size="md"
                      disabled={secretsSaving}
                      onClick={() => {
                        if (!repoUrl || !onSecretsSave) return;
                        setSecretsSaving(true);
                        const secrets: Record<string, string> = {};
                        for (const entry of secretEntries) {
                          const k = entry.key.trim();
                          if (k) secrets[k] = entry.value;
                        }
                        onSecretsSave(repoUrl, secrets);
                        setTimeout(() => {
                          setSecretsSaving(false);
                          setSecretsSaved(true);
                        }, 500);
                      }}
                      className="rounded-md"
                      data-testid="secrets-save"
                    >
                      {secretsSaving ? "Saving..." : secretsSaved ? "Saved" : "Save"}
                    </Button>
                  </div>
                </>
              )}
            </div>
          </TabsContent>

        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
