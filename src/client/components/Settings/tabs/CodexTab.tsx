import type { AgentOption } from "../../../agent-types.js";
import { ProviderAccountsCard } from "../ProviderAccountsCard.js";
import { SubAgentDefaultsSection } from "../SubAgentDefaultsSection.js";

/**
 * docs/150 req 16 — see {@link ClaudeTab}. The provider-wide `CodexAuthCard`
 * is gone from Settings; every Codex subscription, first or fifth, connects
 * through an account row. The device-code challenge now renders on the row that
 * started it (previously the `accountId` on `agent_auth_pending` was dropped
 * and every code landed in the singleton card).
 */
export function CodexTab({
  agent,
  onSetAgentEnv,
}: {
  agent: AgentOption | undefined;
  onSetAgentEnv?: (agentId: string, key: string, value: string) => void;
}) {
  return (
    <div className="px-5 py-4 flex flex-col gap-4 overflow-y-auto h-full">
      <ProviderAccountsCard
        provider="codex"
        agent={agent}
        onSubmitApiKey={(key) => onSetAgentEnv?.("codex", "OPENAI_API_KEY", key)}
      />
      <SubAgentDefaultsSection agent={agent} />
    </div>
  );
}
