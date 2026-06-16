import type { AgentId, SubscriptionLimitsMap } from "../../shared/types.js";

/**
 * Rate-limit + subscription-snapshot handling, extracted from
 * `agent-listeners.ts` (Phase P6 split, docs/201): account-wide rate-limit
 * telemetry routing (docs/135) and reclassification of a generic upstream
 * "monthly usage limit" error against ShipIt's own exhausted-window snapshot.
 * No behavior change.
 */

const AGENT_LIMIT_LABELS: Record<AgentId, string> = {
  claude: "Claude",
  codex: "Codex",
};

/**
 * Upstream agent CLIs can report the generic "org monthly usage limit" even
 * when ShipIt's subscription badge has a fresh exhausted 5h-window snapshot.
 * Correct only that known mismatch; without an exhausted session window, keep
 * the upstream text intact.
 */
export function normalizeAgentUsageLimitError(
  agentId: AgentId,
  message: string,
  limits: SubscriptionLimitsMap | undefined,
): string {
  if (!/monthly usage limit/i.test(message)) return message;

  const sessionLimit = limits?.[agentId]?.session;
  if (!sessionLimit) return message;
  // usedPct is null when the provider hasn't reported utilization yet (Claude
  // CLI 2.1.140 below its warning thresholds — anthropics/claude-code#50518).
  // Without a number we can't claim the window is exhausted, so leave the
  // upstream "monthly usage limit" message intact.
  if (sessionLimit.usedPct === null || sessionLimit.usedPct < 100) return message;

  const reset = new Date(sessionLimit.resetAt);
  const resetText = Number.isNaN(reset.getTime())
    ? sessionLimit.resetAt
    : reset.toISOString();
  const label = AGENT_LIMIT_LABELS[agentId] ?? agentId;
  return `You've hit ${label}'s 5h usage limit. It resets at ${resetText}.`;
}
