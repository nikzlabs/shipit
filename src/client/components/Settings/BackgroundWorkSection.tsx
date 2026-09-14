/**
 * docs/252 phase 7 (req 9) — the visible setting for **which model ShipIt's own
 * background work runs on**: naming a session, writing a pull-request
 * description.
 *
 * Three things the requirement asks of this control, and each one is a decision
 * you can see in the markup:
 *
 *  - **It is a model choice like any other** (req 3), so it lists
 *    `(service, billing mode, model)` triples. Not a harness picker.
 *  - **The harness is derived, never chosen** (req 9). It is shown as a fact —
 *    "runs on Claude Code" — rather than offered as a second control, because a
 *    model offered on two installed harnesses must not become a second decision
 *    for the user to make here.
 *  - **There is no second state to explain.** The server writes this setting the
 *    first time the install can run something (`seedNonTurnModel`), so it always
 *    holds one model. What the section used to carry instead — a "ShipIt's
 *    default" row in the menu, a sentence about following the install, and a
 *    line naming which of the two states was in force — is all gone with the
 *    state itself. Removing it was the point: every word available for that
 *    state (*default*, *auto-configured*, *pinned*) needed a glossary, and the
 *    report that produced the change was that the developer could not read the
 *    line either.
 *
 * **Two rows, not three columns** (2026-08-13). The description used to sit in a
 * column beside the two controls, wrapping at ~34 characters through seven
 * lines. It is now above them, full width, and shorter — the controls state the
 * service and the model, so the line beneath the description carries only what
 * they cannot: the harness this resolved onto.
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
 *
 * **docs/299 phase 2d widened what it offers, and only here.** The options are
 * the server's `backgroundWorkModels`, not `eligibleModelsOf(agentList)`, which
 * is the union over INSTALLED harnesses: background work can run as a direct
 * provider call, so a model provider with no harness belongs in these two
 * pickers and in no other picker in ShipIt. `agentList` is left as the way to
 * name a harness in the derived line, and for nothing else.
 */

import { useRef, useState } from "react";
import { useSettingsStore } from "../../stores/settings-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import { Picker, PickerOption } from "../pickers/Picker.js";
import { ServiceSelector } from "../pickers/ServiceSelector.js";
import {
  modelAfterServiceChange,
  modelsOfService,
  servicesOf,
  serviceKeyOf,
  type ServiceChoice,
} from "../pickers/model-choice.js";
import type { AgentOption } from "../../agent-types.js";

interface Pin {
  serviceId: string;
  billingMode: "sub" | "key";
  modelId: string;
}

export function BackgroundWorkSection({ agentList = [] }: { agentList?: AgentOption[] }) {
  const pinned = useSettingsStore((s) => s.nonTurnModel);
  const resolved = useSettingsStore((s) => s.nonTurnModelResolved);
  const models = useSettingsStore((s) => s.backgroundWorkModels);
  const services = servicesOf(models);

  const latestWrite = useRef(0);
  const [busy, setBusy] = useState(false);

  // Always a triple, never `null`. Clearing the setting is no longer reachable

  const save = async (next: Pin) => {
    const write = ++latestWrite.current;
    setBusy(true);
    const prev = useSettingsStore.getState();
    const previousPin = prev.nonTurnModel;
    const previousResolved = prev.nonTurnModelResolved;

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
      if (write === latestWrite.current) {
        useSettingsStore.getState().setNonTurnModel(
          result.nonTurnModel ?? null,
          result.nonTurnModelResolved ?? null,
        );
      }
    } catch (err) {

      if (write === latestWrite.current) {
        useSettingsStore.getState().setNonTurnModel(previousPin, previousResolved);
      }
      useUiStore.getState().setToast({ message: "Failed to update the background-work model" });
      console.error("[settings] set nonTurnModel failed:", err);
    } finally {
      if (write === latestWrite.current) setBusy(false);
    }
  };

  const pinnedIsStale =
    !!pinned
    && !models.some(
      (m) =>
        m.serviceId === pinned.serviceId
        && m.billingMode === pinned.billingMode
        && m.modelId === pinned.modelId,
    );

  const current = resolved ?? (pinnedIsStale ? undefined : pinned ? { ...pinned } : undefined);
  const serviceModels = modelsOfService(models, current);

  const currentModel = serviceModels.find((m) => m.modelId === current?.modelId)
    ?? current
    ?? pinned
    ?? undefined;

  // The one fact the controls cannot state: HOW the work runs, which has no
  // control of its own. One string, not two conditional elements, so the two
  // states cannot both render.
  const executionLine = !resolved
    ? undefined
    : resolved.execution === "direct"
      ? "Called directly · no harness, no container"
      : resolved.harnessId
        ? `Runs on ${agentList.find((a) => a.id === resolved.harnessId)?.name ?? resolved.harnessId}`
        : undefined;

  const changeService = (service: ServiceChoice) => {
    const next = modelAfterServiceChange(currentModel, modelsOfService(models, service));
    if (!next) return;
    void save({ serviceId: next.serviceId, billingMode: next.billingMode, modelId: next.modelId });
  };

  return (
    <div className="space-y-2.5 py-1" data-testid="background-work-section">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-(--color-text-primary)">Background work</h3>
          {/*
            The examples are examples. "Naming a session or writing a
            pull-request description" is what ShipIt does outside a turn today
            and is not meant as the list — so the sentence names the category
            and gives two of them, rather than reading as a promise that no
            third one exists.
          */}
          <p className="text-xs text-(--color-text-tertiary)">
            What ShipIt runs for its own work, such as naming a session or writing a
            pull-request description.
          </p>
          {executionLine && (
            <p
              className="mt-1 text-[11px] text-(--color-text-tertiary)"
              data-testid="background-work-execution"
            >
              {executionLine}
            </p>
          )}
          {!resolved && pinnedIsStale && pinned && (
            /*
              The pinned model is NAMED here rather than on the model control,
              because that control is gone: its service offers nothing, so under
              req 14 there is no picker to read it off. Naming it in the warning
              keeps the promise the control used to keep — the server still holds
              this pin and fails it on every background job, so the two must
              agree about what it is.
            */
            <p className="mt-1 text-[11px] text-(--color-warning)">
              {/*
                No cause is named: a stale pin says only that it is not among the
                offered options, which also happens with the credential present
                and its harness installed (docs/299-direct-provider-calls req 3).
              */}
              {pinned.modelId} can no longer run background work on this install.
              Background work is failing until you pick another provider.
            </p>
          )}
          {!resolved && !pinnedIsStale && (
            <p className="mt-1 text-[11px] text-(--color-text-tertiary)">
              Nothing to run it on yet — add a provider credential above.
            </p>
          )}
        </div>
        {/*
          req 14 — no service, no controls. The row is absent rather than
          disabled, because an install with nothing configured has nothing to
          choose between and the line above already says so.
        */}
        {(services.length > 0 || (pinnedIsStale && pinned)) && (
        <div className="flex flex-wrap items-center gap-2">
          <ServiceSelector
            services={services}
            selected={current}
            onChange={changeService}
            disabled={busy}
            idPrefix="background-work"
            fallbackLabel={pinnedIsStale && pinned ? pinned.serviceId : "No provider"}
          />
          {serviceModels.length > 0 && (
            <Picker
              label={
                resolved ? resolved.label : pinnedIsStale && pinned ? pinned.modelId : "Unavailable"
              }
              ariaLabel="Model for background work"
              triggerTestId="background-work-model"
              menuTestId="background-work-model-menu"
              menuWidth="w-72"
              align="start"
              disabled={busy}
            >
              {/*
                The models, and nothing else. This menu used to open on a
                "ShipIt's default" row — the unset state, made selectable so the
                user could return to it. The setting is written once now
                (`seedNonTurnModel`), so there is no such state to return to and
                the menu is the same list every other model menu shows.
              */}
              {serviceModels.map((model) => (
                <PickerOption
                  key={`${serviceKeyOf(model)}:${model.modelId}`}
                  label={model.label}

                  selected={current?.modelId === model.modelId}
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
          )}
        </div>
      )}
    </div>
  );
}
