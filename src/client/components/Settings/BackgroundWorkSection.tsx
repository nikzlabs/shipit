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
 */

import { useRef, useState } from "react";
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
  /**
   * Which write is the newest, and whether one is in flight.
   *
   * The `<select>` this replaced was ONE control, so overlapping writes were not
   * reachable; two dependent controls make them ordinary — change the service,
   * then click a model before the response lands. Without this an older
   * response (or an older failure's rollback) overwrites the newer state, and
   * the model menu is briefly still listing the PREVIOUS service's models. The
   * Reviewer tab learned the same lesson from cross-backend review, and this is
   * its counter and its busy gate; found by the same review one surface over.
   */
  const latestWrite = useRef(0);
  const [busy, setBusy] = useState(false);

  // Always a triple, never `null`. Clearing the setting is no longer reachable
  // from the UI — there is nothing to clear it TO, since an empty setting is the
  // state this section stopped having. The endpoint still accepts `null`.
  const save = async (next: Pin) => {
    const write = ++latestWrite.current;
    setBusy(true);
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
      if (write === latestWrite.current) {
        useSettingsStore.getState().setNonTurnModel(
          result.nonTurnModel ?? null,
          result.nonTurnModelResolved ?? null,
        );
      }
    } catch (err) {
      // Roll back only if nothing newer has been sent — otherwise this restores
      // a snapshot the user has already moved on from.
      if (write === latestWrite.current) {
        useSettingsStore.getState().setNonTurnModel(previousPin, previousResolved);
      }
      useUiStore.getState().setToast({ message: "Failed to update the background-work model" });
      console.error("[settings] set nonTurnModel failed:", err);
    } finally {
      if (write === latestWrite.current) setBusy(false);
    }
  };

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
  // The eligible row when there is one; otherwise the resolution or the pin
  // itself, whose identity `modelAfterServiceChange` recovers from the
  // catalogue when no row carries it. A pin
  // whose credential went away has no row at all, and that is exactly when the
  // user re-points this at a service that survived.
  const currentModel = serviceModels.find((m) => m.modelId === current?.modelId)
    ?? current
    ?? pinned
    ?? undefined;

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
          {resolved && (
            /*
              The one fact the two controls below do not state. They name the
              service and the model, so repeating those here would be the same
              fact twice; the harness is derived from the model (req 9) and has
              no control of its own, which is exactly why it is said in words.
            */
            <p className="mt-1 text-[11px] text-(--color-text-tertiary)">
              Runs on {agentList.find((a) => a.id === resolved.harnessId)?.name ?? resolved.harnessId}
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
              {pinned.modelId} is no longer available — its credential or its harness is gone.
              Background work is failing until you pick another service.
            </p>
          )}
          {!resolved && !pinnedIsStale && (
            <p className="mt-1 text-[11px] text-(--color-text-tertiary)">
              Nothing to run it on yet — add a service credential above.
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
            fallbackLabel={pinnedIsStale && pinned ? pinned.serviceId : "No service"}
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
                  // Ticked from what is IN FORCE, not from the stored pin. The
                  // two agree once the setting is written, and on an install
                  // whose first settings read has not happened yet the
                  // resolution is what background work would actually use.
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
