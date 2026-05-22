import { useState, useRef } from "react";
import type { AgentOption } from "../agent-types.js";
import { Button } from "./ui/button.js";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog.js";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs.js";
import { ClaudeAuthCard } from "./ClaudeAuthCard.js";
import { CodexAuthCard, type CodexDeviceAuthState } from "./CodexAuthCard.js";
import { GitHubTokenForm } from "./GitHubTokenForm.js";
import { McpServerSettings } from "./McpServerSettings.js";
import { useUiStore } from "../stores/ui-store.js";
import { useSettingsStore } from "../stores/settings-store.js";

const MAX_LENGTH = 50_000;

// On mobile the tab list collapses from a vertical sidebar into a horizontal
// scrollable strip — each trigger sizes to its label and gets pill-like styling
// so it reads as a tab bar rather than a stretched menu row.
const mobileTabClass = "max-md:w-auto max-md:whitespace-nowrap max-md:rounded-md max-md:px-3 max-md:py-1.5 max-md:text-xs";

type Tab = "agent-claude" | "agent-codex" | "github" | "git" | "instructions" | "mcp" | "advanced";

export interface SettingsProps {
  initialContent: string;
  onSaveInstructions: (content: string) => void;
  githubStatus: { authenticated: boolean; username?: string; avatarUrl?: string };
  onGitHubTokenSubmit: (token: string) => Promise<void> | void;
  onGitHubLogout: () => void;
  authUrl: string | null;
  onApiKey: (key: string) => void;
  onClearApiKey: () => void;
  onStartAuth: () => void;
  onPasteCode: (code: string) => void;
  agentList?: AgentOption[];
  onSetAgentEnv?: (agentId: string, key: string, value: string) => void;
  // Codex (ChatGPT subscription) device-auth — feature 119.
  codexDeviceAuth?: CodexDeviceAuthState | null;
  codexDeviceAuthError?: string | null;
  onStartCodexDeviceAuth?: () => void;
  onCancelCodexDeviceAuth?: () => void;
  onSignOutCodex?: () => void;
  onFullReset?: () => void;
  gitIdentity: { name: string; email: string };
  onGitIdentitySave: (name: string, email: string) => void;
  maxIdleContainers: number;
  onMaxIdleContainersSave: (n: number) => void;
  agentSystemInstructionsEnabled: boolean;
  agentSystemInstructions: string;
  onToggleAgentSystemInstructions: (enabled: boolean) => void;
  hasActiveSession: boolean;
  onClose: () => void;
}

function ToggleSwitch({ enabled, onToggle, testId }: { enabled: boolean; onToggle: (v: boolean) => void; testId?: string }) {
  return (
    <button
      onClick={() => onToggle(!enabled)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
        enabled ? "bg-(--color-accent)" : "bg-(--color-bg-hover)"
      }`}
      role="switch"
      aria-checked={enabled}
      data-testid={testId}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
          enabled ? "translate-x-4.5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

function NotificationSettings() {
  const notifyOnFinish = useSettingsStore((s) => s.notifyOnFinish);
  const soundOnFinish = useSettingsStore((s) => s.soundOnFinish);
  const setNotifyOnFinish = useSettingsStore((s) => s.setNotifyOnFinish);
  const setSoundOnFinish = useSettingsStore((s) => s.setSoundOnFinish);

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-(--color-text-primary)">Notifications</h3>
      <p className="text-sm text-(--color-text-secondary)">
        Get notified when a session needs your attention &mdash; the agent stops and is waiting on you,
        CI fails, or a PR has merge conflicts. The same conditions that highlight a session in the sidebar.
      </p>
      <div className="space-y-2">
        <div className="flex items-center justify-between py-1">
          <div>
            <span className="text-sm text-(--color-text-primary)">Browser notification</span>
            <p className="text-xs text-(--color-text-tertiary)">Show a desktop notification when the tab is in the background</p>
          </div>
          <ToggleSwitch enabled={notifyOnFinish} onToggle={setNotifyOnFinish} testId="settings-notify-on-finish" />
        </div>
        <div className="flex items-center justify-between py-1">
          <div>
            <span className="text-sm text-(--color-text-primary)">Sound</span>
            <p className="text-xs text-(--color-text-tertiary)">Play a chime when a session needs attention</p>
          </div>
          <ToggleSwitch enabled={soundOnFinish} onToggle={setSoundOnFinish} testId="settings-sound-on-finish" />
        </div>
      </div>
    </div>
  );
}

/**
 * Pull-request automation settings (currently just auto-create PR).
 * Rendered inside the GitHub tab when the user is authenticated — without a
 * GitHub token the server-side gate (`githubAuthManager.authenticated` in
 * `agent-execution.ts`) means toggling this on is a no-op.
 *
 * Mirrors the optimistic-set-then-PUT-with-revert pattern that previously
 * lived in `PrLifecycleCard.tsx`'s `AutoCreatePrToggle`. Surfaces a toast on
 * failure (the inline toggle's silent console-only failure made sense next to
 * a busy PR card; in a quiet Settings dialog a visible error is better).
 */
function PullRequestSettings() {
  const autoCreatePr = useSettingsStore((s) => s.autoCreatePr);

  const handleToggle = async (v: boolean) => {
    useSettingsStore.getState().setAutoCreatePr(v);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoCreatePr: v }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      // Revert the optimistic update and surface the failure.
      useSettingsStore.getState().setAutoCreatePr(!v);
      useUiStore.getState().setToast({ message: "Failed to update auto-create PR setting" });
      console.error("[settings] toggle autoCreatePr failed:", err);
    }
  };

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-(--color-text-primary)">Pull Requests</h3>
      <div className="space-y-2">
        <div className="flex items-center justify-between py-1 gap-4">
          <div>
            <span className="text-sm text-(--color-text-primary)">Auto-create PR after every meaningful turn</span>
            <p className="text-xs text-(--color-text-tertiary)">When the agent finishes a turn that changes files, ShipIt opens a pull request automatically.</p>
          </div>
          <ToggleSwitch enabled={autoCreatePr} onToggle={(v) => void handleToggle(v)} testId="settings-auto-create-pr" />
        </div>
      </div>
    </div>
  );
}

function LiveSteeringSettings() {
  const liveSteering = useSettingsStore((s) => s.liveSteering);

  const handleToggle = async (v: boolean) => {
    useSettingsStore.getState().setLiveSteering(v);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ liveSteering: v }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      useSettingsStore.getState().setLiveSteering(!v);
      useUiStore.getState().setToast({ message: "Failed to update live steering setting" });
      console.error("[settings] toggle liveSteering failed:", err);
    }
  };

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-(--color-text-primary)">Live Steering</h3>
      <div className="space-y-2">
        <div className="flex items-center justify-between py-1 gap-4">
          <div>
            <span className="text-sm text-(--color-text-primary)">Inject messages mid-turn</span>
            <p className="text-xs text-(--color-text-tertiary)">Send a message while the agent is running to steer it without waiting for the turn to finish. Experimental — toggle off to return to the stable queue-based mode.</p>
          </div>
          <ToggleSwitch enabled={liveSteering} onToggle={(v) => void handleToggle(v)} testId="settings-live-steering" />
        </div>
      </div>
    </div>
  );
}

function PrCommentSyncSettings() {
  const prCommentSync = useSettingsStore((s) => s.prCommentSync);

  const handleToggle = async (v: boolean) => {
    useSettingsStore.getState().setPrCommentSync(v);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prCommentSync: v }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      useSettingsStore.getState().setPrCommentSync(!v);
      useUiStore.getState().setToast({ message: "Failed to update PR comment sync setting" });
      console.error("[settings] toggle prCommentSync failed:", err);
    }
  };

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-(--color-text-primary)">PR Comment Sync</h3>
      <div className="space-y-2">
        <div className="flex items-center justify-between py-1 gap-4">
          <div>
            <span className="text-sm text-(--color-text-primary)">Reply &amp; resolve PR comments from ShipIt</span>
            <p className="text-xs text-(--color-text-tertiary)">Show reply and resolve controls on PR review threads. Replies and resolutions are written back to GitHub. Experimental — read-side rendering of teammates&apos; comments is always on.</p>
          </div>
          <ToggleSwitch enabled={prCommentSync} onToggle={(v) => void handleToggle(v)} testId="settings-pr-comment-sync" />
        </div>
      </div>
    </div>
  );
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
  codexDeviceAuth,
  codexDeviceAuthError,
  onStartCodexDeviceAuth,
  onCancelCodexDeviceAuth,
  onSignOutCodex,
  onFullReset,
  gitIdentity,
  onGitIdentitySave,
  maxIdleContainers,
  onMaxIdleContainersSave,
  agentSystemInstructionsEnabled,
  agentSystemInstructions,
  onToggleAgentSystemInstructions,
  hasActiveSession,
  onClose,
}: SettingsProps) {
  const activeTab = useUiStore((s) => s.settingsTab) ?? "agent-claude";
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
  const [updateStatus, setUpdateStatus] = useState<{
    available: boolean; behindBy: number; commitMessages: string[]; currentCommit: string;
  } | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateApplying, setUpdateApplying] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const savedRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);


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

  const handleClose = () => {
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

  const generalTabs = ["github", "git", "instructions", "mcp", "advanced"] as const;
  const tabLabel = (tab: Tab) => {
    switch (tab) {
      case "agent-claude": return "Claude";
      case "agent-codex": return "Codex";
      case "github": return "GitHub";
      case "git": return "Git";
      case "instructions": return "Instructions";
      case "mcp": return "MCP Servers";
      case "advanced": return "Advanced";
    }
  };

  return (
    <Dialog open onOpenChange={(isOpen) => { if (!isOpen) handleClose(); }}>
      <DialogContent
        className="rounded-lg border-(--color-border-secondary) max-w-2xl w-full md:mx-4 flex flex-col md:h-120 max-md:h-full"
        data-testid="settings-backdrop"
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-(--color-border-secondary)">
          <DialogTitle className="text-lg font-semibold">Settings</DialogTitle>
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

        {/* Body: sidebar tabs + content (vertical sidebar on desktop, horizontal scroll strip on mobile) */}
        <Tabs value={activeTab} onValueChange={(v) => {
          const tab = v as Tab;
          setActiveTab(tab);
          if (tab === "instructions") {
            requestAnimationFrame(() => textareaRef.current?.focus());
          }
        }} className="flex max-md:flex-col flex-1 min-h-0" orientation="vertical">
          {/* Tab list — vertical sidebar on desktop, horizontal scroll on mobile */}
          <TabsList className="md:w-40 md:shrink-0 md:border-r md:py-2 max-md:flex-row max-md:overflow-x-auto max-md:border-b max-md:px-2 max-md:py-1.5 max-md:gap-1 max-md:shrink-0 border-(--color-border-secondary)">
            <div className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-(--color-text-tertiary) max-md:hidden">
              Agent
            </div>
            <TabsTrigger value="agent-claude" data-testid="settings-tab-agent-claude" className={mobileTabClass}>
              {tabLabel("agent-claude")}
            </TabsTrigger>
            {codexAgent && (
              <TabsTrigger value="agent-codex" data-testid="settings-tab-agent-codex" className={mobileTabClass}>
                {tabLabel("agent-codex")}
              </TabsTrigger>
            )}

            <div className="px-4 py-1.5 mt-3 text-[10px] font-semibold uppercase tracking-wider text-(--color-text-tertiary) max-md:hidden">
              General
            </div>
            {generalTabs.map((tab) => (
              <TabsTrigger key={tab} value={tab} className={mobileTabClass}>
                {tabLabel(tab)}
              </TabsTrigger>
            ))}
          </TabsList>

          {/* Right content area */}
          <TabsContent value="agent-claude">
            <div className="px-5 py-4 flex flex-col gap-4 overflow-y-auto h-full">
              <ClaudeAuthCard
                agent={claudeAgent}
                authUrl={authUrl}
                onStartAuth={onStartAuth}
                onApiKeySubmit={async (key) => { onApiKey(key); return undefined; }}
                onPasteAuthCode={onPasteCode}
                onClearApiKey={onClearApiKey}
              />
            </div>
          </TabsContent>

          <TabsContent value="agent-codex">
            <div className="px-5 py-4 flex flex-col gap-4 overflow-y-auto h-full">
              {codexAgent && (
                <CodexAuthCard
                  agent={codexAgent}
                  deviceAuth={codexDeviceAuth ?? null}
                  deviceAuthError={codexDeviceAuthError ?? null}
                  onStartDeviceAuth={onStartCodexDeviceAuth}
                  onCancelDeviceAuth={onCancelCodexDeviceAuth}
                  onSignOut={onSignOutCodex}
                  onApiKeySubmit={async (key) => { onSetAgentEnv?.("codex", "OPENAI_API_KEY", key); return undefined; }}
                />
              )}
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

          <TabsContent value="mcp">
            <McpServerSettings hasActiveSession={hasActiveSession} />
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

                  <div className="border-t border-(--color-border-secondary)" />

                  <PullRequestSettings />

                  <div className="border-t border-(--color-border-secondary)" />

                  <PrCommentSyncSettings />
                </div>
              ) : (
                <GitHubTokenForm onSubmit={async (t) => { await onGitHubTokenSubmit(t); return undefined; }} />
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
                <h3 className="text-sm font-medium text-(--color-text-primary)">Software Updates</h3>
                <p className="text-sm text-(--color-text-secondary)">
                  Check for new versions and update ShipIt in place.
                </p>
                <div className="flex flex-wrap items-center gap-2 sm:gap-3">
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
                  <Button
                    variant="secondary"
                    size="md"
                    disabled={restarting || updateApplying}
                    onClick={async () => {
                      setRestarting(true);
                      setUpdateError(null);
                      try {
                        const res = await fetch("/api/updates/restart", { method: "POST" });
                        if (!res.ok) {
                          const body = await res.json().catch(() => ({})) as { error?: string };
                          throw new Error(body.error ?? `HTTP ${res.status}`);
                        }
                      } catch (err) {
                        setRestarting(false);
                        setUpdateError((err as Error).message);
                      }
                    }}
                    className="rounded-md"
                    data-testid="settings-restart"
                  >
                    {restarting ? "Restarting..." : "Just Restart"}
                  </Button>
                </div>
                {updateApplying && (
                  <p className="text-sm text-(--color-text-secondary)">
                    Updating... ShipIt will restart momentarily. Refresh the page in a few seconds.
                  </p>
                )}
                {restarting && (
                  <p className="text-sm text-(--color-text-secondary)">
                    Restarting... ShipIt will be back momentarily. Refresh the page in a few seconds.
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

              <LiveSteeringSettings />

              <div className="border-t border-(--color-border-secondary)" />

              <NotificationSettings />

              <div className="border-t border-(--color-border-secondary)" />

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
          </TabsContent>

        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
