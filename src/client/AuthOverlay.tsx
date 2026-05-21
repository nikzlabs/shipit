import { AuthOverlay as AuthOverlayComponent } from "./components/AuthOverlay.js";
import { OnboardingWizard } from "./components/OnboardingWizard.js";
import type { AgentOption } from "./agent-types.js";
import type { CodexDeviceAuthState } from "./components/CodexAuthCard.js";

interface AuthOverlayContainerProps {
  authUrl: string | null;
  showOnboarding: boolean;
  onPasteCode: (code: string) => void;
  onApiKey: (key: string) => void;
  // Onboarding props
  gitIdentityNeeded: boolean;
  agentList: AgentOption[];
  onGitIdentitySubmit: (name: string, email: string) => void;
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
  onPasteCode,
  onApiKey,
  gitIdentityNeeded,
  agentList,
  onGitIdentitySubmit,
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
      {authUrl !== null && !showOnboarding && (
        <AuthOverlayComponent
          url={authUrl}
          onPasteCode={onPasteCode}
          onApiKey={onApiKey}
        />
      )}
      {showOnboarding && (
        <OnboardingWizard
          initialStep={gitIdentityNeeded ? 1 : 2}
          onGitIdentitySubmit={onGitIdentitySubmit}
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
