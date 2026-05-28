import { useState } from "react";
import { XIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog.js";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs.js";
import { SecretsTab } from "./SecretsTab.js";

// On mobile the tab list collapses from a vertical sidebar into a horizontal
// scrollable strip — mirrors Settings.tsx so the two dialogs read alike.
const mobileTabClass = "max-md:w-auto max-md:whitespace-nowrap max-md:rounded-md max-md:px-3 max-md:py-1.5 max-md:text-xs";

type Tab = "deployments" | "secrets";

export interface ProjectSettingsProps {
  /** Repo these settings apply to. Drives the per-repo secret store. */
  repoUrl: string;
  /** Human-readable repo name shown in the dialog title. */
  repoName: string;
  /** Which tab to open on. Defaults to Secrets — the actionable tab. */
  initialTab?: Tab;
  onSecretsSave?: (repoUrl: string, secrets: Record<string, string>) => void;
  onSecretsLoad?: (repoUrl: string) => Promise<Record<string, string>>;
  onClose: () => void;
}

/**
 * Per-repo Project Settings dialog — deployments and secrets. Split out of the
 * workspace-wide Settings dialog (feature: project settings per repo) so these
 * repo-scoped controls are reached from the per-repo menu in the sidebar
 * instead of being mixed in with account/workspace settings.
 */
export function ProjectSettings({
  repoUrl,
  repoName,
  initialTab = "secrets",
  onSecretsSave,
  onSecretsLoad,
  onClose,
}: ProjectSettingsProps) {
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
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-(--color-border-secondary)">
          <DialogTitle className="text-lg font-semibold truncate">
            Project Settings
            <span className="ml-2 text-sm font-normal text-(--color-text-tertiary)">{repoName}</span>
          </DialogTitle>
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

        {/* Body: sidebar tabs + content (vertical on desktop, horizontal strip on mobile) */}
        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as Tab)}
          className="flex max-md:flex-col flex-1 min-h-0"
          orientation="vertical"
        >
          <TabsList className="md:w-40 md:shrink-0 md:border-r md:py-2 max-md:flex-row max-md:overflow-x-auto max-md:border-b max-md:px-2 max-md:py-1.5 max-md:gap-1 max-md:shrink-0 border-(--color-border-secondary)">
            <TabsTrigger value="secrets" data-testid="project-tab-secrets" className={mobileTabClass}>
              Secrets
            </TabsTrigger>
            <TabsTrigger value="deployments" data-testid="project-tab-deployments" className={mobileTabClass}>
              Deployments
            </TabsTrigger>
          </TabsList>

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
                  Secrets are injected into the services that declare them in <code className="px-1 py-0.5 rounded bg-(--color-bg-secondary) text-(--color-text-primary)">x-shipit-secrets</code>. The agent only sees values you explicitly mark with <code className="px-1 py-0.5 rounded bg-(--color-bg-secondary) text-(--color-text-primary)">agent: true</code>.
                </p>
              </div>
              <SecretsTab
                repoUrl={repoUrl}
                onSecretsSave={onSecretsSave}
                onSecretsLoad={onSecretsLoad}
              />
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
