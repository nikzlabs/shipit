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
          <svg className="w-12 h-12 mx-auto text-(--color-text-tertiary)" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 10.5v6m3-3H9m4.06-7.19l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
          </svg>
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
            <p>Click <strong className="text-(--color-text-primary)">+ New Session</strong> next to a repository in the sidebar to start coding.</p>
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
