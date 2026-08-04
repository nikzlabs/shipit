import type { AgentOption } from "../../../agent-types.js";
import { ProviderAccountsCard } from "../ProviderAccountsCard.js";
import { SubAgentDefaultsSection } from "../SubAgentDefaultsSection.js";

/**
 * docs/150 req 16 — this tab used to stack a provider-wide `ClaudeAuthCard`
 * (the only way to connect the *first* subscription) on top of a per-account
 * section (the only way to connect *subsequent* ones). `ProviderAccountsCard`
 * replaces both with a single account-row flow. Onboarding renders this same
 * card now, so no surface connects a first account differently — and
 * `ClaudeAuthCard` itself is gone.
 */
export function ClaudeTab({
  agent,
  onApiKey,
  onClearApiKey,
}: {
  agent: AgentOption | undefined;
  onApiKey: (key: string) => void;
  onClearApiKey: () => void;
}) {
  return (
    <div className="px-5 py-4 flex flex-col gap-4 overflow-y-auto h-full">
      <ProviderAccountsCard
        provider="claude"
        agent={agent}
        onSubmitApiKey={(key) => onApiKey(key)}
        onClearApiKey={onClearApiKey}
      />
      <SubAgentDefaultsSection agent={agent} />
    </div>
  );
}
