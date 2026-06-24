import type { AgentOption } from "../../../agent-types.js";
import { ClaudeAuthCard } from "../../ClaudeAuthCard.js";
import { useSettingsStore } from "../../../stores/settings-store.js";
import { ProviderAccountSection } from "../ProviderAccountSection.js";
import { SubAgentDefaultsSection } from "../SubAgentDefaultsSection.js";

export function ClaudeTab({
  agent,
  authUrl,
  onStartAuth,
  onApiKey,
  onClearApiKey,
  onPasteCode,
}: {
  agent: AgentOption | undefined;
  authUrl: string | null;
  onStartAuth: () => void;
  onApiKey: (key: string) => void;
  onClearApiKey: () => void;
  onPasteCode: (code: string) => void;
}) {
  // A stored Claude account row means there are credentials/state to clear even
  // when the agent reads as unauthenticated (stale/unverifiable token). Surfaces
  // the "Clear saved credentials" reset in ClaudeAuthCard's not-authed panel.
  const claudeHasStoredCredentials = useSettingsStore((s) =>
    s.providerAccounts.some((a) => a.provider === "claude"),
  );

  return (
    <div className="px-5 py-4 flex flex-col gap-4 overflow-y-auto h-full">
      <ClaudeAuthCard
        agent={agent}
        authUrl={authUrl}
        onStartAuth={onStartAuth}
        onApiKeySubmit={async (key) => { onApiKey(key); return undefined; }}
        onPasteAuthCode={onPasteCode}
        onClearApiKey={onClearApiKey}
        hasStoredCredentials={claudeHasStoredCredentials}
      />
      <ProviderAccountSection provider="claude" />
      <SubAgentDefaultsSection agent={agent} />
    </div>
  );
}
