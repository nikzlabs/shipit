import { useSettingsStore } from "../../stores/settings-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import type { AgentOption } from "../../agent-types.js";

/**
 * docs/217 — Control A: per-agent defaults applied when THIS agent is invoked
 * as a sub-agent (`shipit agent run --agent <id>` from inside another session).
 * Lives on the agent's own Settings tab beside its connection card. Independent
 * of the composer's per-session reasoning control (Control B). Reasoning effort
 * is the first member; a default model for the sub-agent invocation is the
 * planned next member of this same section.
 *
 * Self-hides when the agent exposes no reasoning knob.
 */
export function SubAgentDefaultsSection({ agent }: { agent: AgentOption | undefined }) {
  const defaults = useSettingsStore((s) => s.agentSubAgentDefaults);

  if (!agent?.reasoning || agent.reasoning.options.length === 0) return null;
  const reasoning = agent.reasoning;
  const agentId = agent.id;
  const current = defaults[agentId]?.reasoningEffort ?? "";

  const handleChange = async (raw: string) => {
    const effort = raw === "" ? null : raw;
    const prev = useSettingsStore.getState().agentSubAgentDefaults;
    // Optimistic merge.
    const next = {
      ...prev,
      [agentId]: { ...prev[agentId], ...(effort ? { reasoningEffort: effort } : { reasoningEffort: undefined }) },
    };
    useSettingsStore.getState().setAgentSubAgentDefaults(next);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentSubAgentDefaults: { [agentId]: { reasoningEffort: effort } } }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = (await res.json()) as { agentSubAgentDefaults?: Record<string, { reasoningEffort?: string }> };
      if (result.agentSubAgentDefaults) {
        useSettingsStore.getState().setAgentSubAgentDefaults(result.agentSubAgentDefaults);
      }
    } catch (err) {
      useSettingsStore.getState().setAgentSubAgentDefaults(prev);
      useUiStore.getState().setToast({ message: "Failed to update sub-agent reasoning" });
      console.error("[settings] set agentSubAgentDefaults failed:", err);
    }
  };

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-(--color-text-primary)">Sub-agent defaults</h3>
      <div className="flex items-center justify-between py-1 gap-4">
        <div>
          <span className="text-sm text-(--color-text-primary)">{reasoning.label}</span>
          <p className="text-xs text-(--color-text-tertiary)">
            Effort {agent.name} runs with when another agent invokes it as a sub-agent. The active
            session&rsquo;s own turns use the reasoning control next to the composer instead.
          </p>
        </div>
        <select
          value={current}
          onChange={(e) => void handleChange(e.target.value)}
          className="shrink-0 rounded-lg bg-(--color-bg-secondary) border border-(--color-border-secondary) px-2.5 py-1.5 text-sm text-(--color-text-primary) cursor-pointer focus:outline-none focus:border-(--color-border-focus)"
          data-testid={`subagent-reasoning-${agentId}`}
        >
          <option value="">Default</option>
          {reasoning.options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
