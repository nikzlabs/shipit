import { useSettingsStore } from "../../stores/settings-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import type { AgentOption } from "../../agent-types.js";
import type { SubAgentDefaults, SubAgentDefaultsPatch } from "../../../server/shared/types.js";

/** The fields the section edits — drives the merge/clear loop generically. */
const FIELDS: (keyof SubAgentDefaults)[] = ["model", "reasoningEffort"];

/**
 * docs/217 — Control A: per-agent defaults applied when THIS agent is invoked
 * as a sub-agent (`shipit agent run --agent <id>` from inside another session).
 * Lives on the agent's own Settings tab beside its connection card. Independent
 * of the composer's per-session reasoning/model controls (Control B). Holds two
 * members — reasoning effort and the model the sub-agent invocation runs with;
 * each defaults to the backend's own choice (no `--effort` flag / `models[0]`)
 * when left at "Default".
 *
 * Self-hides when the agent exposes neither a reasoning knob nor any models.
 */
export function SubAgentDefaultsSection({ agent }: { agent: AgentOption | undefined }) {
  const defaults = useSettingsStore((s) => s.agentSubAgentDefaults);

  if (!agent) return null;
  const hasReasoning = !!agent.reasoning && agent.reasoning.options.length > 0;
  const hasModels = agent.models.length > 0;
  if (!hasReasoning && !hasModels) return null;

  const agentId = agent.id;
  const current = defaults[agentId] ?? {};

  // Merge a single field via PUT /api/settings, optimistically updating the
  // store and rolling back on failure. `""` clears the field (→ backend default).
  const patchField = async (field: keyof SubAgentDefaults, raw: string) => {
    const prev = useSettingsStore.getState().agentSubAgentDefaults;
    const base = prev[agentId] ?? {};
    // Rebuild the merged entry from scratch so a cleared field drops out without
    // a dynamic delete: the edited field takes `raw`, the others keep their value.
    const merged: SubAgentDefaults = {};
    for (const key of FIELDS) {
      const value = key === field ? raw : base[key];
      if (value) merged[key] = value;
    }
    useSettingsStore.getState().setAgentSubAgentDefaults({ ...prev, [agentId]: merged });
    // The PUT body uses null to clear; "" → null.
    const body: SubAgentDefaultsPatch = { [field]: raw === "" ? null : raw };
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentSubAgentDefaults: { [agentId]: body } }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = (await res.json()) as { agentSubAgentDefaults?: Record<string, SubAgentDefaults> };
      if (result.agentSubAgentDefaults) {
        useSettingsStore.getState().setAgentSubAgentDefaults(result.agentSubAgentDefaults);
      }
    } catch (err) {
      useSettingsStore.getState().setAgentSubAgentDefaults(prev);
      useUiStore.getState().setToast({ message: "Failed to update sub-agent defaults" });
      console.error("[settings] set agentSubAgentDefaults failed:", err);
    }
  };

  const selectClass =
    "shrink-0 rounded-lg bg-(--color-bg-secondary) border border-(--color-border-secondary) px-2.5 py-1.5 text-sm text-(--color-text-primary) cursor-pointer focus:outline-none focus:border-(--color-border-focus)";

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-(--color-text-primary)">Sub-agent defaults</h3>

      {hasModels && (
        <div className="flex items-center justify-between py-1 gap-4">
          <div>
            <span className="text-sm text-(--color-text-primary)">Model</span>
            <p className="text-xs text-(--color-text-tertiary)">
              Model {agent.name} runs with when another agent invokes it as a sub-agent. The active
              session&rsquo;s own turns use the model picker next to the composer instead.
            </p>
          </div>
          <select
            value={current.model ?? ""}
            onChange={(e) => void patchField("model", e.target.value)}
            className={selectClass}
            data-testid={`subagent-model-${agentId}`}
          >
            <option value="">Default</option>
            {agent.models.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
      )}

      {hasReasoning && agent.reasoning && (
        <div className="flex items-center justify-between py-1 gap-4">
          <div>
            <span className="text-sm text-(--color-text-primary)">{agent.reasoning.label}</span>
            <p className="text-xs text-(--color-text-tertiary)">
              Effort {agent.name} runs with when another agent invokes it as a sub-agent. The active
              session&rsquo;s own turns use the reasoning control next to the composer instead.
            </p>
          </div>
          <select
            value={current.reasoningEffort ?? ""}
            onChange={(e) => void patchField("reasoningEffort", e.target.value)}
            className={selectClass}
            data-testid={`subagent-reasoning-${agentId}`}
          >
            <option value="">Default</option>
            {agent.reasoning.options.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
