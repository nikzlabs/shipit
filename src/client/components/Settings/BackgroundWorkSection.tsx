/**
 * docs/252 phase 7 (req 9) — the visible setting for **which model ShipIt's own
 * background work runs on**: naming a session, writing a pull-request
 * description.
 *
 * Three things the requirement asks of this control, and each one is a decision
 * you can see in the markup:
 *
 *  - **It is a model choice like any other** (req 3), so it lists the same
 *    `(service, billing mode, model)` triples the composer's picker offers,
 *    grouped by service. Not a service picker and not a harness picker.
 *  - **The harness is derived, never chosen** (req 9). It is shown as a fact —
 *    "runs on Claude Code" — rather than offered as a second control, because a
 *    model offered on two installed harnesses must not become a second decision
 *    for the user to make here.
 *  - **Unset is a state, not an empty value.** The first option is "ShipIt's
 *    default", labelled with what that currently resolves to, so the user can
 *    see the setting follows the install instead of pointing at a vendor they
 *    may stop paying for. Making the default *visible* is exactly what stops it
 *    from re-creating the hidden dependency req 9 exists to remove.
 */

import { useSettingsStore } from "../../stores/settings-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import type { AgentOption, EligibleModelOption } from "../../agent-types.js";

/** The wire form of a pin, and the value encoded into each `<option>`. */
interface Pin {
  serviceId: string;
  billingMode: "sub" | "key";
  modelId: string;
}

const OPTION_SEPARATOR = "|";

function encode(pin: Pin): string {
  return [pin.serviceId, pin.billingMode, pin.modelId].join(OPTION_SEPARATOR);
}

function decode(raw: string): Pin | null {
  const parts = raw.split(OPTION_SEPARATOR);
  if (parts.length !== 3) return null;
  const [serviceId, billingMode, modelId] = parts;
  if (billingMode !== "sub" && billingMode !== "key") return null;
  return { serviceId, billingMode, modelId };
}

const MODE_LABEL: Record<"sub" | "key", string> = { sub: "Subscription", key: "API key" };

/**
 * Every eligible triple across INSTALLED harnesses, de-duplicated.
 *
 * De-duplicated because the harness is derived: one model offered on both
 * installed harnesses is one choice here, not two. Which harness runs it is the
 * server's derivation (first installed harness in catalogue order), and showing
 * the same model twice would imply the user picks between them.
 */
function eligibleChoices(agents: AgentOption[]): EligibleModelOption[] {
  const seen = new Set<string>();
  const out: EligibleModelOption[] = [];
  for (const agent of agents) {
    if (!agent.installed) continue;
    for (const model of agent.eligibleModels ?? []) {
      const key = encode(model);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(model);
    }
  }
  return out;
}

export function BackgroundWorkSection({ agentList = [] }: { agentList?: AgentOption[] }) {
  const pinned = useSettingsStore((s) => s.nonTurnModel);
  const resolved = useSettingsStore((s) => s.nonTurnModelResolved);
  const choices = eligibleChoices(agentList);

  const save = async (raw: string) => {
    const prev = useSettingsStore.getState();
    const previousPin = prev.nonTurnModel;
    const previousResolved = prev.nonTurnModelResolved;
    const next = raw === "" ? null : decode(raw);
    if (raw !== "" && !next) return;
    // Optimistic on the PIN only. `nonTurnModelResolved` is the server's
    // derivation (which harness, what label) and guessing it here would be a
    // second implementation of req 9's rule — the response carries the real one.
    useSettingsStore.getState().setNonTurnModel(next, previousResolved);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nonTurnModel: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = (await res.json()) as {
        nonTurnModel?: Pin;
        nonTurnModelResolved?: NonNullable<ReturnType<typeof useSettingsStore.getState>["nonTurnModelResolved"]>;
      };
      useSettingsStore.getState().setNonTurnModel(
        result.nonTurnModel ?? null,
        result.nonTurnModelResolved ?? null,
      );
    } catch (err) {
      useSettingsStore.getState().setNonTurnModel(previousPin, previousResolved);
      useUiStore.getState().setToast({ message: "Failed to update the background-work model" });
      console.error("[settings] set nonTurnModel failed:", err);
    }
  };

  const defaultLabel = resolved?.source === "default"
    ? `ShipIt's default — ${resolved.serviceName} · ${resolved.label}`
    : "ShipIt's default — the first model this install can run";

  const selectClass =
    "shrink-0 max-w-[18rem] rounded-lg bg-(--color-bg-secondary) border border-(--color-border-secondary) px-2.5 py-1.5 text-sm text-(--color-text-primary) cursor-pointer focus:outline-none focus:border-(--color-border-focus)";

  // Group by `(service, mode)` so the list reads the way the composer's picker
  // does — the same axis every other model surface in this feature groups on.
  const groups = new Map<string, { label: string; models: EligibleModelOption[] }>();
  for (const model of choices) {
    const key = `${model.serviceId}:${model.billingMode}`;
    const group = groups.get(key)
      ?? { label: `${model.serviceName} · ${MODE_LABEL[model.billingMode]}`, models: [] };
    group.models.push(model);
    groups.set(key, group);
  }

  return (
    <div className="space-y-2" data-testid="background-work-section">
      <h3 className="text-sm font-medium text-(--color-text-primary)">Background work</h3>
      <div className="flex items-start justify-between gap-4 py-1">
        <div className="min-w-0">
          <span className="text-sm text-(--color-text-primary)">Model</span>
          <p className="text-xs text-(--color-text-tertiary)">
            What ShipIt runs when it names a session or writes a pull-request description —
            chosen independently of the model any session uses. Left on the default it follows
            whatever this install can run, so it never points at a service you have stopped
            paying for.
          </p>
          {resolved && (
            <p className="mt-1 text-[11px] text-(--color-text-tertiary)">
              Currently: {resolved.serviceName} · {resolved.label}
              {" · runs on "}
              {agentList.find((a) => a.id === resolved.harnessId)?.name ?? resolved.harnessId}
            </p>
          )}
          {!resolved && (
            <p className="mt-1 text-[11px] text-(--color-text-tertiary)">
              Nothing to run it on yet — add a service credential above.
            </p>
          )}
        </div>
        <select
          value={pinned ? encode(pinned) : ""}
          onChange={(e) => void save(e.target.value)}
          className={selectClass}
          data-testid="background-work-model"
          aria-label="Model for background work"
        >
          <option value="">{defaultLabel}</option>
          {[...groups.entries()].map(([key, group]) => (
            <optgroup key={key} label={group.label}>
              {group.models.map((m) => (
                <option key={encode(m)} value={encode(m)}>{m.label}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
    </div>
  );
}
