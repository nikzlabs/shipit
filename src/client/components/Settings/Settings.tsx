import { useState, useRef } from "react";
import { XIcon } from "@phosphor-icons/react";
import type { AgentOption } from "../../agent-types.js";
import { ICON_SIZE } from "../../design-tokens.js";
import { Button } from "../ui/button.js";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog.js";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../ui/tabs.js";
import { type CodexDeviceAuthState } from "../CodexAuthCard.js";
import { SettingsIntegrations } from "../SettingsIntegrations.js";
import { SettingsEgress } from "../SettingsEgress.js";
import { SkillsTab } from "../SkillsTab.js";
import { KeybindingSettings } from "../KeybindingSettings.js";
import { useUiStore } from "../../stores/ui-store.js";
import { ClaudeTab } from "./tabs/ClaudeTab.js";
import { CodexTab } from "./tabs/CodexTab.js";
import { InstructionsTab } from "./tabs/InstructionsTab.js";
import { GitTab } from "./tabs/GitTab.js";
import { VoiceTab } from "./tabs/VoiceTab.js";
import { AdvancedTab } from "./tabs/AdvancedTab.js";

// On mobile the tab list collapses from a vertical sidebar into a horizontal
// scrollable strip — each trigger sizes to its label and gets pill-like styling
// so it reads as a tab bar rather than a stretched menu row.
const mobileTabClass = "max-md:w-auto max-md:whitespace-nowrap max-md:rounded-md max-md:px-3 max-md:py-1.5 max-md:text-xs";

type Tab = "agent-claude" | "agent-codex" | "integrations" | "git" | "instructions" | "skills" | "keyboard" | "voice" | "network" | "advanced";

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
  /** docs/128 — resume/navigate to a session (e.g. a freshly created ops session). */
  onResumeSession?: (sessionId: string) => void;
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
  onResumeSession,
}: SettingsProps) {
  const activeTab = useUiStore((s) => s.settingsTab) ?? "agent-claude";
  const setActiveTab = useUiStore((s) => s.setSettingsTab);
  const [content, setContent] = useState(initialContent);
  const savedRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  const claudeAgent = agentList.find((a) => a.id === "claude");
  const codexAgent = agentList.find((a) => a.id === "codex");

  const generalTabs = ["integrations", "git", "instructions", "skills", "keyboard", "voice", "network", "advanced"] as const;
  const tabLabel = (tab: Tab) => {
    switch (tab) {
      case "agent-claude": return "Claude";
      case "agent-codex": return "Codex";
      case "integrations": return "Integrations";
      case "git": return "Git";
      case "instructions": return "Instructions";
      case "skills": return "Skills";
      case "keyboard": return "Keyboard";
      case "voice": return "Voice";
      case "network": return "Network";
      case "advanced": return "Advanced";
    }
  };
  // Skills tab renders a two-pane layout (catalog list + Monaco preview when
  // the install sheet opens) and wants more horizontal room than the existing
  // form-shaped tabs. Swap the dialog class per active tab so other tabs keep
  // their tight 672 px width.
  const dialogClass = activeTab === "skills"
    ? "rounded-lg border-(--color-border-secondary) max-w-5xl w-full md:mx-4 flex flex-col md:h-[80vh] max-md:h-full"
    : "rounded-lg border-(--color-border-secondary) max-w-2xl w-full md:mx-4 flex flex-col md:h-120 max-md:h-full";

  return (
    <Dialog open onOpenChange={(isOpen) => { if (!isOpen) handleClose(); }}>
      <DialogContent
        className={dialogClass}
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
            className="h-9 w-9 max-md:h-10 max-md:w-10"
            aria-label="Close"
          >
            <XIcon size={ICON_SIZE.MD} weight="bold" />
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
          <TabsList className="md:w-40 md:shrink-0 md:min-h-0 md:overflow-y-auto md:border-r md:py-2 max-md:flex-row max-md:overflow-x-auto max-md:border-b max-md:px-2 max-md:py-1.5 max-md:gap-1 max-md:shrink-0 border-(--color-border-secondary)">
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
            <ClaudeTab
              agent={claudeAgent}
              authUrl={authUrl}
              onStartAuth={onStartAuth}
              onApiKey={onApiKey}
              onClearApiKey={onClearApiKey}
              onPasteCode={onPasteCode}
            />
          </TabsContent>

          <TabsContent value="agent-codex">
            <CodexTab
              agent={codexAgent}
              codexDeviceAuth={codexDeviceAuth}
              codexDeviceAuthError={codexDeviceAuthError}
              onStartCodexDeviceAuth={onStartCodexDeviceAuth}
              onCancelCodexDeviceAuth={onCancelCodexDeviceAuth}
              onSignOutCodex={onSignOutCodex}
              onSetAgentEnv={onSetAgentEnv}
            />
          </TabsContent>

          <TabsContent value="instructions">
            <InstructionsTab
              content={content}
              onContentChange={setContent}
              textareaRef={textareaRef}
              onSave={handleSave}
              onClose={onClose}
              agentSystemInstructionsEnabled={agentSystemInstructionsEnabled}
              agentSystemInstructions={agentSystemInstructions}
              onToggleAgentSystemInstructions={onToggleAgentSystemInstructions}
            />
          </TabsContent>

          <TabsContent value="skills">
            <SkillsTab />
          </TabsContent>

          <TabsContent value="keyboard">
            <KeybindingSettings />
          </TabsContent>

          <TabsContent value="voice">
            <VoiceTab />
          </TabsContent>

          <TabsContent value="integrations">
            <SettingsIntegrations
              githubStatus={githubStatus}
              onGitHubLogout={onGitHubLogout}
              onGitHubTokenSubmit={onGitHubTokenSubmit}
              hasActiveSession={hasActiveSession}
            />
          </TabsContent>

          <TabsContent value="git">
            <GitTab gitIdentity={gitIdentity} onGitIdentitySave={onGitIdentitySave} />
          </TabsContent>

          <TabsContent value="network">
            <div className="px-5 py-4 flex flex-col gap-4 overflow-y-auto h-full">
              <SettingsEgress />
            </div>
          </TabsContent>

          <TabsContent value="advanced">
            <AdvancedTab
              onFullReset={onFullReset}
              maxIdleContainers={maxIdleContainers}
              onMaxIdleContainersSave={onMaxIdleContainersSave}
              onClose={onClose}
              onResumeSession={onResumeSession}
            />
          </TabsContent>

        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
