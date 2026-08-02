import { OnboardingWizard } from "./components/OnboardingWizard.js";
import type { AgentOption } from "./agent-types.js";

/**
 * Gates first-run onboarding. The standalone "Authentication Required" overlay
 * that used to render here when `authUrl` was set has been removed: it popped a
 * blocking modal in every open browser window (the URL arrived over a global
 * SSE broadcast), even tabs unrelated to the session that needed auth. Agent
 * authentication now lives in Settings → Agents — the model selector disables
 * unauthenticated agents, and an unauthenticated turn returns an error pointing
 * there.
 *
 * The wizard's agent step no longer takes sign-in props at all: it renders the
 * same per-account connect surface as Settings, which owns its own challenge
 * state keyed by account (docs/150 req 16).
 */
interface AuthOverlayContainerProps {
  showOnboarding: boolean;
  // Onboarding props
  /** GitHub not yet connected — start the wizard at step 1 (Connect GitHub). */
  githubNeeded: boolean;
  agentList: AgentOption[];
  onGitHubTokenSubmit: (token: string) => Promise<boolean>;
  onClaudeApiKeySubmit: (key: string) => Promise<boolean>;
  onCodexApiKeySubmit: (key: string) => Promise<boolean>;
  onRefreshAgents: () => Promise<void>;
  onComplete: () => void;
}

export function AuthOverlayContainer({
  showOnboarding,
  githubNeeded,
  agentList,
  onGitHubTokenSubmit,
  onClaudeApiKeySubmit,
  onCodexApiKeySubmit,
  onRefreshAgents,
  onComplete,
}: AuthOverlayContainerProps) {
  return (
    <>
      {showOnboarding && (
        <OnboardingWizard
          initialStep={githubNeeded ? 1 : 2}
          onGitHubTokenSubmit={onGitHubTokenSubmit}
          agents={agentList}
          onClaudeApiKeySubmit={onClaudeApiKeySubmit}
          onCodexApiKeySubmit={onCodexApiKeySubmit}
          onRefreshAgents={onRefreshAgents}
          onComplete={onComplete}
        />
      )}
    </>
  );
}
