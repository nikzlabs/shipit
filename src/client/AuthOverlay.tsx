import { GitHubGate } from "./components/GitHubGate.js";

/**
 * Gates first-run setup. The standalone "Authentication Required" overlay that
 * used to render here when `authUrl` was set has been removed: it popped a
 * blocking modal in every open browser window (the URL arrived over a global
 * SSE broadcast), even tabs unrelated to the session that needed auth.
 *
 * docs/257 — what remains is the **GitHub** half, and only that. Harness
 * credentials left this overlay entirely: they are connected from
 * `HarnessOnboardingPanel` in the conversation view (first run) or from
 * Settings → Services (any time after), neither of which covers the product.
 * The GitHub step keeps today's blocking behaviour in full, which is why this
 * container still exists at all.
 */
interface AuthOverlayContainerProps {
  /** GitHub is not connected (latched in `App.tsx`) — block the product. */
  showGitHubGate: boolean;
  onGitHubTokenSubmit: (token: string) => Promise<boolean>;
  /** Dismiss the gate. Fires when GitHub connects — there is no other exit. */
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
