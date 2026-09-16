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
import { InstructionsTab, MAX_LENGTH } from "./tabs/InstructionsTab.js";
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
  initialContent: string;
  initialOpsContent: string;
  onSaveInstructions: (content: string, opsContent: string) => void;
  githubStatus: { authenticated: boolean; username?: string; avatarUrl?: string };
  onGitHubTokenSubmit: (token: string) => Promise<void> | void;
  onGitHubLogout: () => void;
  agentList?: AgentOption[];
  onFullReset?: () => void;
  gitIdentity: { name: string; email: string };
  onGitIdentitySave: (name: string, email: string) => void;
  agentSystemInstructions: string;
  hasActiveSession: boolean;
  onClose: () => void;
}

export function Settings({
  initialContent,
  initialOpsContent,
  onSaveInstructions,
  githubStatus,
  onGitHubTokenSubmit,
  onGitHubLogout,
  agentList = [],
  onFullReset,
  gitIdentity,
  onGitIdentitySave,
  agentSystemInstructions,
  hasActiveSession,
  onClose,
}: SettingsProps) {
  const activeTab = useUiStore((s) => s.settingsTab) ?? "services";
  const setActiveTab = useUiStore((s) => s.setSettingsTab);
  const [content, setContent] = useState(initialContent);
  const [opsContent, setOpsContent] = useState(initialOpsContent);
  const savedRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /*
    What the drafts were seeded from. A settings write elsewhere — another tab,
    or an agent's applied proposal — refetches the stored value into the store
    and so into these props, while the drafts stay where the user left them
    (docs/299-agent-settings-access → Apply goes through a shared layer).

    An UNTOUCHED box adopts the new value: it would otherwise keep showing what
    was stored when the dialog opened and write it back on Save, silently
    reverting a change the user never saw. A box being edited keeps its draft and
    says the stored value moved, because adopting there would throw away typing.
  */
  const seededRef = useRef({ content: initialContent, ops: initialOpsContent });
  if (initialContent !== seededRef.current.content && content === seededRef.current.content) {
    seededRef.current = { ...seededRef.current, content: initialContent };
    setContent(initialContent);
  }
  if (initialOpsContent !== seededRef.current.ops && opsContent === seededRef.current.ops) {
    seededRef.current = { ...seededRef.current, ops: initialOpsContent };
    setOpsContent(initialOpsContent);
  }
  const changedElsewhere =
    initialContent !== seededRef.current.content || initialOpsContent !== seededRef.current.ops;

  // A rejected save closes the modal and drops the draft, so the keyboard path
  // enforces the same limit the Save button disables itself on.
  const saveBlocked = content.length > MAX_LENGTH || opsContent.length > MAX_LENGTH;

  const handleSave = () => {
    if (saveBlocked) return;
    savedRef.current = true;
    onSaveInstructions(content, opsContent);
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
            {SETTINGS_TABS.map((tab) => (
              <TabsTrigger key={tab} value={tab} data-testid={`settings-tab-${tab}`} className={mobileTabClass}>
                {SETTING_TAB_LABELS[tab]}
              </TabsTrigger>
            ))}
          </TabsList>

          {/* Right content area */}
          <TabsContent value="instructions">
            <InstructionsTab
              content={content}
              onContentChange={setContent}
              opsContent={opsContent}
              onOpsContentChange={setOpsContent}
              textareaRef={textareaRef}
              onSave={handleSave}
              onClose={onClose}
              agentSystemInstructions={agentSystemInstructions}
              changedElsewhere={changedElsewhere}
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
            <GitTab gitIdentity={gitIdentity} onGitIdentitySave={onGitIdentitySave} />
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
