import { OnboardingWizard } from "./components/OnboardingWizard.js";
import type { AgentOption } from "./agent-types.js";
import type { CodexDeviceAuthState } from "./components/CodexAuthCard.js";

/**
 * Gates first-run onboarding. The standalone "Authentication Required" overlay
 * that used to render here when `authUrl` was set has been removed: it popped a
 * blocking modal in every open browser window (the URL arrived over a global
 * SSE broadcast), even tabs unrelated to the session that needed auth. Agent
 * authentication now lives in Settings → Agents — the model selector disables
 * unauthenticated agents, and an unauthenticated turn returns an error pointing
 * there. `authUrl` is still threaded through to the onboarding wizard's Claude
 * sign-in step (the one place an inline OAuth prompt is intentional).
 */
interface AuthOverlayContainerProps {
  authUrl: string | null;
  showOnboarding: boolean;
  // Onboarding props
  gitIdentityNeeded: boolean;
  agentList: AgentOption[];
  onGitHubTokenSubmit: (token: string) => Promise<boolean>;
  onClaudeApiKeySubmit: (key: string) => Promise<boolean>;
  onCodexApiKeySubmit: (key: string) => Promise<boolean>;
  onStartClaudeAuth: () => void;
  onPasteAuthCode: (code: string) => void;
  onRefreshAgents: () => Promise<void>;
  // Codex (ChatGPT subscription) device-auth — feature 119.
  codexDeviceAuth?: CodexDeviceAuthState | null;
  codexDeviceAuthError?: string | null;
  onStartCodexDeviceAuth?: () => void;
  onCancelCodexDeviceAuth?: () => void;
  onComplete: () => void;
}

export function AuthOverlayContainer({
  authUrl,
  showOnboarding,
  gitIdentityNeeded,
  agentList,
  onGitHubTokenSubmit,
  onClaudeApiKeySubmit,
  onCodexApiKeySubmit,
  onStartClaudeAuth,
  onPasteAuthCode,
  onRefreshAgents,
  codexDeviceAuth,
  codexDeviceAuthError,
  onStartCodexDeviceAuth,
  onCancelCodexDeviceAuth,
  onComplete,
}: AuthOverlayContainerProps) {
  return (
    <>
      {showOnboarding && (
        <OnboardingWizard
          initialStep={gitIdentityNeeded ? 1 : 2}
          onGitHubTokenSubmit={onGitHubTokenSubmit}
          agents={agentList}
          onClaudeApiKeySubmit={onClaudeApiKeySubmit}
          onCodexApiKeySubmit={onCodexApiKeySubmit}
          onStartClaudeAuth={onStartClaudeAuth}
          authUrl={authUrl}
          onPasteAuthCode={onPasteAuthCode}
          onRefreshAgents={onRefreshAgents}
          codexDeviceAuth={codexDeviceAuth}
          codexDeviceAuthError={codexDeviceAuthError}
          onStartCodexDeviceAuth={onStartCodexDeviceAuth}
          onCancelCodexDeviceAuth={onCancelCodexDeviceAuth}
          onComplete={onComplete}
        />
      )}
    </>
  );
}
