import { FolderPlusIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";

export interface HomeScreenProps {
  onAddRepo: () => void;
  hasRepos: boolean;
}

export function HomeScreen({ onAddRepo, hasRepos }: HomeScreenProps) {
  if (!hasRepos) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 min-h-0 px-4">
        <div className="text-center space-y-4">
          <FolderPlusIcon size={ICON_SIZE.XL} className="mx-auto text-(--color-text-tertiary)" />
          <p className="text-sm text-(--color-text-secondary)">Add a repository to get started</p>
          <Button
            variant="primary"
            size="lg"
            onClick={onAddRepo}
            className="rounded-lg"
          >
            Add Repository
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center flex-1 min-h-0 px-4">
      <div className="max-w-md space-y-6">
        <div className="text-center space-y-2">
          <h2 className="text-lg font-semibold text-(--color-text-primary)">Welcome to ShipIt</h2>
          <p className="text-sm text-(--color-text-secondary)">Chat with Claude to build and ship code.</p>
        </div>
        <div className="space-y-3 text-sm text-(--color-text-secondary)">
          <div className="flex items-start gap-3">
            <span className="flex items-center justify-center w-5 h-5 rounded-full bg-(--color-success-subtle) text-(--color-success) text-xs font-medium shrink-0 mt-0.5">1</span>
            <p>Click <strong className="text-(--color-text-primary)">+ New Session</strong> in the sidebar to start coding.</p>
          </div>
          <div className="flex items-start gap-3">
            <span className="flex items-center justify-center w-5 h-5 rounded-full bg-(--color-success-subtle) text-(--color-success) text-xs font-medium shrink-0 mt-0.5">2</span>
            <p>Describe what you want to build or change. Claude will write the code for you.</p>
          </div>
          <div className="flex items-start gap-3">
            <span className="flex items-center justify-center w-5 h-5 rounded-full bg-(--color-success-subtle) text-(--color-success) text-xs font-medium shrink-0 mt-0.5">3</span>
            <p>See live results in the preview panel as Claude makes changes.</p>
          </div>
        </div>
        <div className="pt-2 text-center">
          <Button
            variant="ghost"
            size="sm"
            onClick={onAddRepo}
          >
            + Add another repository
          </Button>
        </div>
      </div>
    </div>
  );
}
