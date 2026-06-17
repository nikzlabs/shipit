import { FolderPlusIcon, CubeIcon, GithubLogoIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";

export interface HomeScreenProps {
  onAddRepo: () => void;
  /** docs/211 — open the Sandbox capability dialog. The supported no-GitHub
   *  on-ramp: a repo-less workspace the agent clones into itself. */
  onCreateSandbox: () => void;
  /** Whether GitHub is connected. Drives which on-ramp leads (repos vs sandbox)
   *  so a manual-identity user isn't funneled into a GitHub-only dead end. */
  githubAuthenticated: boolean;
  hasRepos: boolean;
}

export function HomeScreen({ onAddRepo, onCreateSandbox, githubAuthenticated, hasRepos }: HomeScreenProps) {
  if (!hasRepos) {
    // Two on-ramps. When GitHub is connected, adding a repo is the primary path
    // and a sandbox is the lighter alternative. When it isn't (e.g. "Set up
    // manually instead"), a sandbox is the immediate way to start building and
    // "Connect GitHub" becomes the secondary action — so manual identity always
    // leads somewhere real instead of a repo dialog that can only fail.
    return (
      <div className="flex flex-col items-center justify-center flex-1 min-h-0 px-4">
        <div className="text-center space-y-5 max-w-sm">
          <FolderPlusIcon size={ICON_SIZE.XL} className="mx-auto text-(--color-text-tertiary)" />
          <p className="text-sm text-(--color-text-secondary)">
            Start building — add a GitHub repository, or spin up a sandbox the agent manages for you.
          </p>
          <div className="flex flex-col gap-2.5">
            {githubAuthenticated ? (
              <>
                <Button variant="primary" size="lg" onClick={onAddRepo} className="rounded-lg gap-2">
                  <FolderPlusIcon size={ICON_SIZE.SM} weight="bold" />
                  Add Repository
                </Button>
                <Button variant="ghost" size="md" onClick={onCreateSandbox} className="gap-2">
                  <CubeIcon size={ICON_SIZE.SM} weight="fill" className="text-(--color-sandbox)" />
                  Start a sandbox session
                </Button>
              </>
            ) : (
              <>
                <Button variant="primary" size="lg" onClick={onCreateSandbox} className="rounded-lg gap-2">
                  <CubeIcon size={ICON_SIZE.SM} weight="fill" />
                  Start a sandbox session
                </Button>
                <Button variant="ghost" size="md" onClick={onAddRepo} className="gap-2">
                  <GithubLogoIcon size={ICON_SIZE.SM} weight="fill" />
                  Connect GitHub to add repositories
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center flex-1 min-h-0 px-4">
      <div className="max-w-md space-y-6">
        <div className="text-center space-y-2">
          <h2 className="text-lg font-semibold text-(--color-text-primary)">Welcome to ShipIt</h2>
          <p className="text-sm text-(--color-text-secondary)">An AI editor for building and shipping code from a chat.</p>
        </div>
        <div className="space-y-3 text-sm text-(--color-text-secondary)">
          <div className="flex items-start gap-3">
            <span className="flex items-center justify-center w-5 h-5 rounded-full bg-(--color-success-subtle) text-(--color-success) text-xs font-medium shrink-0 mt-0.5">1</span>
            <p>Click <strong className="text-(--color-text-primary)">+ New Session</strong> in the sidebar to start coding.</p>
          </div>
          <div className="flex items-start gap-3">
            <span className="flex items-center justify-center w-5 h-5 rounded-full bg-(--color-success-subtle) text-(--color-success) text-xs font-medium shrink-0 mt-0.5">2</span>
            <p>Describe what you want to build or change. The agent will write the code for you.</p>
          </div>
          <div className="flex items-start gap-3">
            <span className="flex items-center justify-center w-5 h-5 rounded-full bg-(--color-success-subtle) text-(--color-success) text-xs font-medium shrink-0 mt-0.5">3</span>
            <p>See live results in the preview panel as the agent makes changes.</p>
          </div>
        </div>
        <div className="pt-2 flex items-center justify-center gap-2">
          <Button variant="ghost" size="md" onClick={onAddRepo}>
            + Add another repository
          </Button>
          <Button variant="ghost" size="md" onClick={onCreateSandbox} className="gap-1.5">
            <CubeIcon size={ICON_SIZE.SM} weight="fill" className="text-(--color-sandbox)" />
            Sandbox session
          </Button>
        </div>
      </div>
    </div>
  );
}
