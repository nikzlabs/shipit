import { useState, useRef } from "react";
import type { AgentOption } from "../../agent-types.js";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog.js";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../ui/tabs.js";
import { SettingsIntegrations } from "../SettingsIntegrations.js";
import { SettingsEgress } from "../SettingsEgress.js";
import { SkillsTab } from "../SkillsTab.js";
import { KeybindingSettings } from "../KeybindingSettings.js";
import { useUiStore } from "../../stores/ui-store.js";
import { ServicesPanel } from "./ServicesPanel.js";
import { BackgroundWorkSection } from "./BackgroundWorkSection.js";
import { InstructionsTab } from "./tabs/InstructionsTab.js";
import { GitTab } from "./tabs/GitTab.js";
import { VoiceTab } from "./tabs/VoiceTab.js";
import { AdvancedTab } from "./tabs/AdvancedTab.js";
import { ReviewerTab } from "./tabs/ReviewerTab.js";

// On mobile the tab list collapses from a vertical sidebar into a horizontal
// scrollable strip — each trigger sizes to its label and gets pill-like styling
// so it reads as a tab bar rather than a stretched menu row.
const mobileTabClass = "max-md:w-auto max-md:whitespace-nowrap max-md:rounded-md max-md:px-3 max-md:py-1.5 max-md:text-xs";

/**
 * docs/252 — there is no per-vendor tab, and Services leads.
 *
 * Settings used to open on an **Agent** group whose two tabs (`Claude`,
 * `Codex`) each held a copy of the accounts card plus the sub-agent defaults.
 * Both halves were wrong for this feature: a credential belongs to a *service*,
 * not to the harness that happens to drive it, so listing them per harness is
 * the conflation docs/252 exists to remove — and the accounts card is now one
 * of the Services cards, so the tab was a second editor for one fact. The tabs
 * are gone, Services is first, and Services is where Settings opens.
 */
type Tab = "services" | "reviewer" | "integrations" | "git" | "instructions" | "skills" | "keyboard" | "voice" | "network" | "advanced";

// docs/261 phase 3 — `reviewer` sits directly after `services`, because it is
// the one setting that reads entirely off the credentials that tab configures:
// an auto-configured reviewer changes the moment a service is added. Services
// stays first and stays the default (docs/252 D1); nothing here reorders it.
const TABS = ["services", "reviewer", "integrations", "git", "instructions", "skills", "keyboard", "voice", "network", "advanced"] as const;

export interface SettingsProps {
  initialContent: string;
  onSaveInstructions: (content: string) => void;
  githubStatus: { authenticated: boolean; username?: string; avatarUrl?: string };
  onGitHubTokenSubmit: (token: string) => Promise<void> | void;
  onGitHubLogout: () => void;
  agentList?: AgentOption[];
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

export function Settings({
  initialContent,
  onSaveInstructions,
  githubStatus,
  onGitHubTokenSubmit,
  onGitHubLogout,
  agentList = [],
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
  const activeTab = useUiStore((s) => s.settingsTab) ?? "services";
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

  const tabLabel = (tab: Tab) => {
    switch (tab) {
      case "services": return "Services";
      case "reviewer": return "Reviewer";
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
        <div className="flex items-center px-5 py-4 border-b border-(--color-border-secondary)">
          <DialogTitle className="text-lg font-semibold">Settings</DialogTitle>
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
            {TABS.map((tab) => (
              <TabsTrigger key={tab} value={tab} data-testid={`settings-tab-${tab}`} className={mobileTabClass}>
                {tabLabel(tab)}
              </TabsTrigger>
            ))}
          </TabsList>

          {/* Right content area */}
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

          {/* docs/252 phase 2 — the one place credentials live. The panel takes
              no Settings props and brings no chrome, because docs/257's
              onboarding hosts the same component; the tab supplies the padding
              and the scroll container every other tab here supplies.

              docs/252 phase 7 (req 9) — the background-work model sits under the
              services it draws from: it is a `(service, billing mode, model)`
              choice like any other, and the list it offers is exactly what the
              cards above made eligible. It lives at this level rather than
              inside the panel so that onboarding, which hosts the panel, does
              not ask a first-run user to pick one — the setting defaults to
              whatever the install can run. */}
          <TabsContent value="services">
            <div className="px-5 py-4 flex flex-col gap-4 overflow-y-auto h-full">
              <ServicesPanel agentList={agentList} />
              <div className="border-t border-(--color-border-secondary) pt-4">
                <BackgroundWorkSection agentList={agentList} />
              </div>
            </div>
          </TabsContent>

          {/* docs/261 phase 3 (reqs 1, 5, 8) — the two configured reviewers,
              each labelled auto-configured or pinned with what it resolves to. */}
          <TabsContent value="reviewer">
            <ReviewerTab agentList={agentList} />
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
            />
          </TabsContent>

        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
