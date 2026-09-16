// eslint-disable-next-line no-restricted-imports -- useEffect: the dialog's own teardown, dropping uncommitted drafts
import { useEffect } from "react";
import type { AgentOption } from "../../agent-types.js";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog.js";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../ui/tabs.js";
import { SettingsIntegrations } from "../SettingsIntegrations.js";
import { SettingsEgress } from "../SettingsEgress.js";
import { SkillsTab } from "../SkillsTab.js";
import { KeybindingSettings } from "../KeybindingSettings.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import { ServicesPanel } from "./ServicesPanel.js";
import { BackgroundWorkSection } from "./BackgroundWorkSection.js";
import { InstructionsTab } from "./tabs/InstructionsTab.js";
import { GitTab } from "./tabs/GitTab.js";
import { VoiceTab } from "./tabs/VoiceTab.js";
import { AdvancedTab } from "./tabs/AdvancedTab.js";
import { RolesTab } from "./tabs/RolesTab.js";
// One map for the dialog's own tab strip and for anything else that names where
// a setting lives, so the two cannot say different words for the same tab.
import { SETTING_TAB_LABELS } from "../../../server/shared/settings-catalogue/index.js";

const mobileTabClass = "max-md:w-auto max-md:whitespace-nowrap max-md:rounded-md max-md:px-3 max-md:py-1.5 max-md:text-xs";

/**
 * Every tab this dialog renders, in order. Exported because
 * `settings-coverage.test.tsx` walks each one: a tab added here but not there
 * would be a pane the coverage guard never sees.
 */
export const SETTINGS_TABS = ["services", "roles", "integrations", "git", "instructions", "skills", "keyboard", "voice", "network", "advanced"] as const;

type Tab = (typeof SETTINGS_TABS)[number];

export interface SettingsProps {
  githubStatus: { authenticated: boolean; username?: string; avatarUrl?: string };
  onGitHubTokenSubmit: (token: string) => Promise<void> | void;
  onGitHubLogout: () => void;
  agentList?: AgentOption[];
  onFullReset?: () => void;
  hasActiveSession: boolean;
  onClose: () => void;
}

export function Settings({
  githubStatus,
  onGitHubTokenSubmit,
  onGitHubLogout,
  agentList = [],
  onFullReset,
  hasActiveSession,
  onClose,
}: SettingsProps) {
  const activeTab = useUiStore((s) => s.settingsTab) ?? "services";
  const setActiveTab = useUiStore((s) => s.setSettingsTab);

  /*
    An edit nobody saved is discarded when the dialog goes, which is what the
    drafts did when they lived in this component's own state. They live in the
    store now because the Save that commits them is a tab's rather than a
    control's (docs/308-data-driven-settings, `DeclaredCommit.tsx`).
  */
  // eslint-disable-next-line no-restricted-syntax -- cleanup: drafts outlive this component, so closing has to drop them
  useEffect(() => () => { useSettingsStore.getState().clearSettingDrafts(); }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const dialogClass = activeTab === "skills"
    ? "rounded-lg border-(--color-border-secondary) max-w-5xl w-full md:mx-4 flex flex-col md:h-[80vh] max-md:h-full"
    : "rounded-lg border-(--color-border-secondary) max-w-2xl w-full md:mx-4 flex flex-col md:h-120 max-md:h-full";

  return (
    <Dialog open onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
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
        <Tabs value={activeTab} onValueChange={(v) => { setActiveTab(v as Tab); }} className="flex max-md:flex-col flex-1 min-h-0" orientation="vertical">
          {/* Tab list — vertical sidebar on desktop, horizontal scroll on mobile */}
          <TabsList className="md:w-40 md:shrink-0 md:min-h-0 md:overflow-y-auto md:border-r md:py-2 max-md:flex-row max-md:overflow-x-auto max-md:border-b max-md:px-2 max-md:py-1.5 max-md:gap-1 max-md:shrink-0 border-(--color-border-secondary)">
            {SETTINGS_TABS.map((tab) => (
              <TabsTrigger key={tab} value={tab} data-testid={`settings-tab-${tab}`} className={mobileTabClass}>
                {SETTING_TAB_LABELS[tab]}
              </TabsTrigger>
            ))}
          </TabsList>

          {/* Right content area */}
          <TabsContent value="instructions">
            <InstructionsTab onClose={onClose} />
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

          {/* docs/264 phase 2 (reqs 5, 17) — every agent role: the reviewer with
              its two ranked candidate slots (docs/261 phase 3, reqs 1, 5, 8),
              then the list of pinned roles, each edited in the role editor. */}
          <TabsContent value="roles">
            <RolesTab agentList={agentList} />
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
            <GitTab />
          </TabsContent>

          <TabsContent value="network">
            <div className="px-5 py-4 flex flex-col gap-4 overflow-y-auto h-full">
              <SettingsEgress />
            </div>
          </TabsContent>

          <TabsContent value="advanced">
            <AdvancedTab onFullReset={onFullReset} />
          </TabsContent>

        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
