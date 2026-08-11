/**
 * docs/252 phase 7 (req 9) — the visible setting for **which model ShipIt's own
 * background work runs on**: naming a session, writing a pull-request
 * description.
 *
 * Three things the requirement asks of this control, and each one is a decision
 * you can see in the markup:
 *
 *  - **It is a model choice like any other** (req 3), so it lists the same
 *    `(service, billing mode, model)` triples the composer's picker offers.
 *    Not a harness picker.
 *  - **The harness is derived, never chosen** (req 9). It is shown as a fact —
 *    "runs on Claude Code" — rather than offered as a second control, because a
 *    model offered on two installed harnesses must not become a second decision
 *    for the user to make here.
 *  - **Unset is a state, not an empty value.** The first option is "ShipIt's
 *    default", labelled with what that currently resolves to, so the user can
 *    see the setting follows the install instead of pointing at a vendor they
 *    may stop paying for. Making the default *visible* is exactly what stops it
 *    from re-creating the hidden dependency req 9 exists to remove.
 *
 * **docs/261 phase 6 (reqs 11, 12, 13) replaced the control itself.** This was a
 * native `<select>` with `<optgroup>` headers — the one model surface in ShipIt
 * that matched nothing else, and the one that put every model of every service
 * in a single list. It is now the same `Picker` the composer and the Reviewer
 * tab render, with the service as its own control ahead of the model. What is
 * chosen is unchanged: still a triple, still one write.
 *
 * No reasoning control here, and that is not an omission: non-turn work has no
 * level to set. Adding one would make this file a second source of requirements
 * for a setting docs/252 owns.
 */

import { useSettingsStore } from "../../stores/settings-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import { Picker, PickerOption } from "../pickers/Picker.js";
import { ServiceSelector } from "../pickers/ServiceSelector.js";
import {
  eligibleModelsOf,
  modelAfterServiceChange,
  modelsOfService,
  servicesOf,
  serviceKeyOf,
  type ServiceChoice,
} from "../pickers/model-choice.js";
import type { AgentOption } from "../../agent-types.js";

/** The wire form of a pin. */
interface Pin {
  serviceId: string;
  billingMode: "sub" | "key";
  modelId: string;
}

export function BackgroundWorkSection({ agentList = [] }: { agentList?: AgentOption[] }) {
  const pinned = useSettingsStore((s) => s.nonTurnModel);
  const resolved = useSettingsStore((s) => s.nonTurnModelResolved);
  const models = eligibleModelsOf(agentList);
  const services = servicesOf(models);

  const save = async (next: Pin | null) => {
    const prev = useSettingsStore.getState();
    const previousPin = prev.nonTurnModel;
    const previousResolved = prev.nonTurnModelResolved;
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

  const defaultDetail = resolved?.source === "default"
    ? `${resolved.serviceName} · ${resolved.label}`
    : "the first model this install can run";

  // A pin the install can no longer run is NOT in `models` — its credential or
  // its harness went away. Without saying so the controls would read as the
  // default while the server still holds the pin and fails it on every session.
  // Naming the pin's own ids is worse than naming a service and a model, and a
  // great deal better than a control that looks unset; found by cross-backend
  // review when this was a `<select>` with no row for the pin.
  const pinnedIsStale =
    !!pinned
    && !models.some(
      (m) =>
        m.serviceId === pinned.serviceId
        && m.billingMode === pinned.billingMode
        && m.modelId === pinned.modelId,
    );

  // The two controls read the resolution, not the pin: it carries the service
  // and the model the server actually settled on, which is the same thing on a
  // healthy pin and the honest answer when a pin went stale.
  const current = resolved ?? (pinnedIsStale ? undefined : pinned ? { ...pinned } : undefined);
  const serviceModels = modelsOfService(models, current);
  const currentModel = serviceModels.find((m) => m.modelId === current?.modelId);

  const changeService = (service: ServiceChoice) => {
    const next = modelAfterServiceChange(currentModel, modelsOfService(models, service));
    if (!next) return;
    void save({ serviceId: next.serviceId, billingMode: next.billingMode, modelId: next.modelId });
  };

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
          {!resolved && pinnedIsStale && (
            <p className="mt-1 text-[11px] text-(--color-warning)">
              The model you chose is no longer available — its credential or its harness is
              gone. Background work is failing until you pick another.
            </p>
          )}
          {!resolved && !pinnedIsStale && (
            <p className="mt-1 text-[11px] text-(--color-text-tertiary)">
              Nothing to run it on yet — add a service credential above.
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <ServiceSelector
            services={services}
            selected={current}
            onChange={changeService}
            idPrefix="background-work"
            fallbackLabel={pinnedIsStale && pinned ? pinned.serviceId : "No service"}
          />
          <Picker
            label={
              resolved ? resolved.label : pinnedIsStale && pinned ? pinned.modelId : "Default"
            }
            ariaLabel="Model for background work"
            triggerTestId="background-work-model"
            menuTestId="background-work-model-menu"
            menuWidth="w-72"
            align="end"
          >
            {/*
              Unset as a labelled option rather than a blank (req 9), first in
              the list and carrying what it currently resolves to.
            */}
            <PickerOption
              label="ShipIt's default"
              detail={defaultDetail}
              selected={!pinned}
              onSelect={() => void save(null)}
              testId="background-work-model-default"
            />
            {serviceModels.map((model) => (
              <PickerOption
                key={`${serviceKeyOf(model)}:${model.modelId}`}
                label={model.label}
                selected={!!pinned && pinned.modelId === model.modelId}
                onSelect={() =>
                  void save({
                    serviceId: model.serviceId,
                    billingMode: model.billingMode,
                    modelId: model.modelId,
                  })
                }
                testId={`background-work-model-option-${model.modelId}`}
              />
            ))}
          </Picker>
        </div>
      </div>
    </div>
  );
}
