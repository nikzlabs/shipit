import { useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog.js";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs.js";
import { DeclaredSettings } from "./Settings/DeclaredSettings.js";
import { useProjectRepoUrl } from "./Settings/components/project-repo.js";
import { parseRepoLabel } from "../utils/repo-label.js";

const mobileTabClass = "max-md:w-auto max-md:whitespace-nowrap max-md:rounded-md max-md:px-3 max-md:py-1.5 max-md:text-xs";

/**
 * Every tab this dialog renders, in order. Exported for the same reason as
 * `SETTINGS_TABS`: the coverage guard walks each one.
 */
export const PROJECT_SETTINGS_TABS = ["secrets", "deployments", "appearance"] as const;

type Tab = (typeof PROJECT_SETTINGS_TABS)[number];

const TAB_LABEL: Record<Tab, string> = {
  secrets: "Secrets",
  deployments: "Deployments",
  appearance: "Appearance",
};

export interface ProjectSettingsProps {

  initialTab?: Tab;
  onClose: () => void;
}

/**
 * The second dialog (docs/308-data-driven-settings req 10). Every row on every
 * tab is generated from the declarations since slice 7, so what is left here is
 * the chrome: the header, the tab strip, and the deployment guide that is not a
 * setting at all (inventory.md P12).
 *
 * The repository is NOT passed in — every control reads which one this dialog is
 * open for (`Settings/components/project-repo.ts`), because a generated one takes
 * the setting's key and nothing else, and the title reads the same one so the
 * dialog cannot name a repository its rows are not about.
 */
export function ProjectSettings({
  initialTab = "secrets",
  onClose,
}: ProjectSettingsProps) {
  const repoUrl = useProjectRepoUrl();
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <Dialog open onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent
        className="rounded-lg border-(--color-border-secondary) max-w-2xl w-full md:mx-4 flex flex-col md:h-120 max-md:h-full"
        data-testid="project-settings-backdrop"
        onKeyDown={handleKeyDown}
      >
        {/* Header — pr leaves room for the dialog's corner close button */}
        <div className="flex items-center px-5 py-4 pr-12 border-b border-(--color-border-secondary)">
          <DialogTitle className="text-lg font-semibold truncate">
            Project Settings
            <span className="ml-2 text-sm font-normal text-(--color-text-tertiary)">
              {repoUrl ? parseRepoLabel(repoUrl) : ""}
            </span>
          </DialogTitle>
        </div>

        {/* Body: sidebar tabs + content (vertical on desktop, horizontal strip on mobile) */}
        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as Tab)}
          className="flex max-md:flex-col flex-1 min-h-0"
          orientation="vertical"
        >
          <TabsList className="md:w-40 md:shrink-0 md:border-r md:py-2 max-md:flex-row max-md:overflow-x-auto max-md:border-b max-md:px-2 max-md:py-1.5 max-md:gap-1 max-md:shrink-0 border-(--color-border-secondary)">
            {PROJECT_SETTINGS_TABS.map((tab) => (
              <TabsTrigger key={tab} value={tab} data-testid={`project-tab-${tab}`} className={mobileTabClass}>
                {TAB_LABEL[tab]}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="deployments">
            <div className="px-5 py-4 flex flex-col gap-4 overflow-y-auto h-full" data-testid="deployments-tab">
              {/* docs/287 — the agent-merge grant. One toggle does not justify a
                  navigation category of its own, and this tab is the one place
                  in the dialog already about what happens to the repo without
                  the user doing it by hand. Its heading is the declaration's
                  `section`; the sentence under it is about the section rather
                  than about the setting, so it stays here (P12). */}
              <DeclaredSettings
                tab="project-deployments"
                notes={{
                  "Agent permissions": (
                    <p className="text-xs text-(--color-text-secondary)">
                      What agents working in this repository may do on their own.
                    </p>
                  ),
                }}
              />

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

          {/* The tab is the scroll container around the panel `project.secrets`
              names; the panel's own Save sticks to the bottom of it, because a
              long secret list must never push Save out of sight. */}
          <TabsContent value="secrets">
            <div className="px-5 py-4 flex flex-col gap-4 overflow-y-auto h-full">
              <DeclaredSettings tab="project-secrets" />
            </div>
          </TabsContent>

          {/* docs/254 — per-repo appearance. Currently just the sidebar identity
              color; it gets its own tab rather than riding along in Deployments
              or Secrets because neither is about how the repo is displayed. */}
          <TabsContent value="appearance">
            <div className="px-5 py-4 flex flex-col gap-4 overflow-y-auto h-full" data-testid="appearance-tab">
              <DeclaredSettings tab="project-appearance" />
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
