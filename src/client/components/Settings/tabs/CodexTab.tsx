import type { AgentOption } from "../../../agent-types.js";
import { CodexAuthCard, type CodexDeviceAuthState } from "../../CodexAuthCard.js";
import { ProviderAccountSection } from "../ProviderAccountSection.js";
import { SubAgentDefaultsSection } from "../SubAgentDefaultsSection.js";

export function CodexTab({
  agent,
  codexDeviceAuth,
  codexDeviceAuthError,
  onStartCodexDeviceAuth,
  onCancelCodexDeviceAuth,
  onSignOutCodex,
  onSetAgentEnv,
}: {
  agent: AgentOption | undefined;
  codexDeviceAuth?: CodexDeviceAuthState | null;
  codexDeviceAuthError?: string | null;
  onStartCodexDeviceAuth?: () => void;
  onCancelCodexDeviceAuth?: () => void;
  onSignOutCodex?: () => void;
  onSetAgentEnv?: (agentId: string, key: string, value: string) => void;
}) {
  return (
    <div className="px-5 py-4 flex flex-col gap-4 overflow-y-auto h-full">
      {agent && (
        <CodexAuthCard
          agent={agent}
          deviceAuth={codexDeviceAuth ?? null}
          deviceAuthError={codexDeviceAuthError ?? null}
          onStartDeviceAuth={onStartCodexDeviceAuth}
          onCancelDeviceAuth={onCancelCodexDeviceAuth}
          onSignOut={onSignOutCodex}
          onApiKeySubmit={async (key) => { onSetAgentEnv?.("codex", "OPENAI_API_KEY", key); return undefined; }}
        />
      )}
      <ProviderAccountSection provider="codex" />
      <SubAgentDefaultsSection agent={agent} />
    </div>
  );
}
