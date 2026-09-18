import { GitHubGate } from "./components/GitHubGate.js";

interface AuthOverlayContainerProps {
  showGitHubGate: boolean;
  onGitHubTokenSubmit: (token: string) => Promise<boolean>;
  onComplete: () => void;
}

export function AuthOverlayContainer({
  showGitHubGate,
  onGitHubTokenSubmit,
  onComplete,
}: AuthOverlayContainerProps) {
  return (
    <>
      {showGitHubGate && (
        <GitHubGate
          onGitHubTokenSubmit={onGitHubTokenSubmit}
          onComplete={onComplete}
        />
      )}
    </>
  );
}
