import { useSettingsStore } from "../../stores/settings-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import type { AgentOption } from "../../agent-types.js";
import type { SubAgentDefaults, SubAgentDefaultsPatch } from "../../../server/shared/types.js";

/**
 * The fields the section edits — drives the merge/clear loop generically.
 *
 * docs/252 — deliberately NOT `keyof SubAgentDefaults`: that type also carries
 * `serviceId`/`billingMode`, which are part of the model's identity rather than
 * controls of their own, and widening the loop over them is a type error the
 * compiler catches rather than a silently editable field.
 */
const FIELDS = ["model", "reasoningEffort"] as const;
type EditableField = (typeof FIELDS)[number];

/** One row of the model `<select>`, identified by its whole triple. */
interface ModelOption {
  /** `serviceId:billingMode:modelId` — the `<option>` value, since ids repeat. */
  value: string;
  serviceId: string;
  serviceName: string;
  billingMode: "sub" | "key";
  modelId: string;
  label: string;
}

/**
 * docs/252 phase 4 — the sub-agent model list gains the service axis, which is
 * phase 3's deferred half.
 *
 * `agent.models` was already narrowed to what this install can run (the registry
 * derives `capabilities.models` from the eligible set), so this is not about
 * credentials. It is about the id being ambiguous: the same model is reachable
 * through a vendor directly and through a gateway, and through two modes of one
 * service, at different prices (req 5). A bare-id list cannot say which the user
 * meant, so the server guessed — and could only ever produce one of the two.
 *
 * Falls back to `agent.models` as one unnamed group when `eligibleModels` is
 * absent or empty — an older wire payload, or a registry with no credential
 * source wired — which is what the section showed before the service axis
 * existed.
 */
function modelOptionsFor(agent: AgentOption): ModelOption[] {
  if (agent.eligibleModels && agent.eligibleModels.length > 0) {
    return agent.eligibleModels.map((m) => ({
      value: `${m.serviceId}:${m.billingMode}:${m.modelId}`,
      serviceId: m.serviceId,
      serviceName: m.serviceName,
      billingMode: m.billingMode,
      modelId: m.modelId,
      label: m.modelId,
    }));
  }
  return agent.models.map((m) => ({
    value: m,
    serviceId: "",
    serviceName: "",
    billingMode: "key" as const,
    modelId: m,
    label: m,
  }));
}

/** Group the options by `(service, billing mode)`, preserving catalogue order. */
function groupOptions(options: ModelOption[]): {
  key: string;
  serviceName: string;
  billingMode: "sub" | "key";
  rows: ModelOption[];
}[] {
  const groups: { key: string; serviceName: string; billingMode: "sub" | "key"; rows: ModelOption[] }[] = [];
  for (const option of options) {
    const key = `${option.serviceId}:${option.billingMode}`;
    let group = groups.find((g) => g.key === key);
    if (!group) {
      group = { key, serviceName: option.serviceName, billingMode: option.billingMode, rows: [] };
      groups.push(group);
    }
    group.rows.push(option);
  }
  return groups;
}

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
  const options = modelOptionsFor(agent);
  const groups = groupOptions(options);
  // Match on the whole triple where the stored default carries one, so a model
  // id offered by two services highlights the row it was chosen from.
  const currentValue = current.model
    ? (current.serviceId && current.billingMode
        ? `${current.serviceId}:${current.billingMode}:${current.model}`
        : (options.find((o) => o.modelId === current.model)?.value ?? ""))
    : "";

  // Merge a single field via PUT /api/settings, optimistically updating the
  // store and rolling back on failure. `""` clears the field (→ backend default).
  //
  // docs/252 phase 4 — `pick` carries the model's `(service, billing mode)` when
  // the edited field is the model. `serviceId`/`billingMode` are not controls of
  // their own — they are part of the model's identity — so they ride with it
  // rather than appearing in FIELDS.
  const patchField = async (
    field: EditableField,
    raw: string,
    pick?: { serviceId: string; billingMode: "sub" | "key" },
  ) => {
    const prev = useSettingsStore.getState().agentSubAgentDefaults;
    const base = prev[agentId] ?? {};
    // Rebuild the merged entry from scratch so a cleared field drops out without
    // a dynamic delete: the edited field takes `raw`, the others keep their value.
    const merged: SubAgentDefaults =
      field === "model"
        ? (pick ? { serviceId: pick.serviceId, billingMode: pick.billingMode } : {})
        : { serviceId: base.serviceId, billingMode: base.billingMode };
    for (const key of FIELDS) {
      const value = key === field ? raw : base[key];
      if (value) merged[key] = value;
    }
    useSettingsStore.getState().setAgentSubAgentDefaults({ ...prev, [agentId]: merged });
    // The PUT body uses null to clear; "" → null.
    const body: SubAgentDefaultsPatch = {
      [field]: raw === "" ? null : raw,
      ...(field === "model" && pick ? pick : {}),
    };
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
            value={currentValue}
            onChange={(e) => {
              const row = options.find((o) => o.value === e.target.value);
              if (!e.target.value) { void patchField("model", ""); return; }
              if (!row) return;
              void patchField(
                "model",
                row.modelId,
                row.serviceId ? { serviceId: row.serviceId, billingMode: row.billingMode } : undefined,
              );
            }}
            className={selectClass}
            data-testid={`subagent-model-${agentId}`}
          >
            <option value="">Default</option>
            {groups.map((group) =>
              group.serviceName ? (
                <optgroup
                  key={group.key}
                  label={`${group.serviceName} — ${group.billingMode === "sub" ? "Subscription" : "API key"}`}
                >
                  {group.rows.map((row) => (
                    <option key={row.value} value={row.value}>{row.label}</option>
                  ))}
                </optgroup>
              ) : (
                group.rows.map((row) => (
                  <option key={row.value} value={row.value}>{row.label}</option>
                ))
              ),
            )}
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
