/**
 * docs/264 phase 2 (req 17) — **a role is edited in its own editor, not in a row
 * of inline controls.**
 *
 * A role carries a name, a description, standing instructions and five
 * parameters. That is more than a row of dropdowns can hold legibly, and
 * standing instructions are free text that needs room — so opening a role gives
 * one place to edit all of it, and saving is **one write of the whole role**
 * rather than a control-by-control trickle (the Reviewer tab's shape, which is
 * right for two ranked slots and wrong for this).
 *
 * Three things this file is careful about.
 *
 * **The harness is a real control, not a readout** (req 6). An earlier draft of
 * the design said every model has exactly one harness, so the field could ship
 * read-only; that is false — `deepseek-v4-flash` and `deepseek-v4-pro` are
 * carried by *both* harnesses, so a read-only field would leave a DeepSeek role
 * unable to say which harness it means, which is the expressiveness req 6 exists
 * to give it. So: a picker where the model has more than one valid harness, a
 * readout where it has exactly one, and the stored id as text where it has none.
 *
 * **The unresolved role stays editable.** When a stored model, service or
 * harness no longer exists the shared pickers have no option to select, and
 * would either drop the field or silently show the first available value. Every
 * control here falls back to the *stored* string, so the editor opens on what
 * the role actually holds and the user re-points it deliberately.
 *
 * **Nothing here decides what runs.** The server validates the whole tuple on
 * save with the harness-explicit validator (req 6), and its refusal names the
 * parameter. This file offers what the server said is eligible; it does not
 * reimplement which harness can carry which model.
 */

import { useState } from "react";
import { BrainIcon, WarningIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../../design-tokens.js";
import { Button } from "../../ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog.js";
import { Picker, PickerOption } from "../../pickers/Picker.js";
import { ServiceSelector } from "../../pickers/ServiceSelector.js";
import {
  eligibleModelsOf,
  harnessesForModel,
  modelAfterServiceChange,
  modelsOfService,
  servicesOf,
  type HarnessChoice,
  type ServiceChoice,
} from "../../pickers/model-choice.js";
import type { AgentOption, EligibleModelOption } from "../../../agent-types.js";
import type { RoleView, RoleWrite } from "../../../../server/shared/types/agent-types.js";

const INPUT_CLASS =
  "w-full rounded-lg bg-(--color-bg-secondary) border border-(--color-border-secondary) px-3 py-2 "
  + "text-sm text-(--color-text-primary) placeholder-(--color-text-tertiary) focus:outline-none "
  + "focus:border-(--color-border-focus)";

/**
 * The five parameters, as the editor holds them while they are being edited.
 *
 * `reasoningEffort` is `undefined` for **Default** — the same encoding the
 * composer's picker uses (`ReasoningSelector.tsx`), and the same one the role is
 * stored and spawned with.
 */
interface DraftParams {
  harnessId: string;
  serviceId: string;
  billingMode: "sub" | "key";
  modelId: string;
  reasoningEffort: string | undefined;
}

/** What both pickers show for "no flag, the harness's own level". */
const DEFAULT_LEVEL_LABEL = "Default";

export function RoleEditor({
  role,
  agentList,
  busy,
  error,
  onCancel,
  onSave,
}: {
  /** The role being edited, or `undefined` to create one. */
  role: RoleView | undefined;
  agentList: AgentOption[];
  busy: boolean;
  /** The server's refusal, verbatim — it names the parameter that is wrong. */
  error: string | undefined;
  onCancel: () => void;
  onSave: (name: string, write: RoleWrite) => void;
}) {
  const models = eligibleModelsOf(agentList);
  const services = servicesOf(models);
  const [name, setName] = useState(role?.reserved ? role.name : (role?.name ?? ""));
  const [description, setDescription] = useState(role?.description ?? "");
  const [prompt, setPrompt] = useState(role?.prompt ?? "");
  const [params, setParams] = useState<DraftParams | undefined>(() =>
    initialParams(role, models, agentList),
  );

  const reserved = role?.reserved ?? false;
  const serviceModels = params ? modelsOfService(models, params) : [];
  const harnesses = params ? harnessesForModel(agentList, params) : [];
  const harness = harnesses.find((h) => h.id === params?.harnessId);
  const modelLabel =
    serviceModels.find((m) => m.modelId === params?.modelId)?.label ?? params?.modelId ?? "";

  /**
   * Move the draft onto a new model, keeping the harness and the level **only
   * where they still apply**.
   *
   * Not a silent repair: this is the draft the user is looking at, and the
   * control shows the value that would be saved. The alternative — leaving a
   * level the newly-chosen harness does not declare — would show a tuple the
   * server is about to refuse, with nothing on screen saying why.
   */
  const moveTo = (model: EligibleModelOption) => {
    setParams((prev) => {
      const next: DraftParams = {
        harnessId: prev?.harnessId ?? "",
        serviceId: model.serviceId,
        billingMode: model.billingMode,
        modelId: model.modelId,
        reasoningEffort: prev?.reasoningEffort,
      };
      const valid = harnessesForModel(agentList, next);
      const harnessId = valid.some((h) => h.id === next.harnessId)
        ? next.harnessId
        : (valid[0]?.id ?? next.harnessId);
      return { ...next, harnessId, reasoningEffort: effortFor(valid, harnessId, next.reasoningEffort) };
    });
  };

  const changeService = (service: ServiceChoice) => {
    const next = modelAfterServiceChange(params, modelsOfService(models, service));
    if (next) moveTo(next);
  };

  const changeHarness = (choice: HarnessChoice) => {
    setParams((prev) =>
      prev
        ? {
            ...prev,
            harnessId: choice.id,
            reasoningEffort: effortFor([choice], choice.id, prev.reasoningEffort),
          }
        : prev,
    );
  };

  const trimmedName = name.trim();
  // Req 18 — uniqueness is the server's to enforce (it holds the list); the only
  // thing the editor knows is that an unnamed role cannot be saved.
  const canSave = !busy && (reserved || (!!trimmedName && !!params));

  const submit = () => {
    if (!canSave) return;
    // `reserved` implies a role, but only to a reader — the compiler needs the
    // role itself, and its name is the one that cannot change (req 2).
    onSave(role?.reserved ? role.name : name, {
      ...(role ? { previousName: role.name } : {}),
      description,
      prompt,
      params:
        reserved || !params
          ? { kind: "auto" }
          : {
              kind: "pinned",
              harnessId: params.harnessId as "claude" | "codex" | "opencode" | "grok",
              serviceId: params.serviceId,
              billingMode: params.billingMode,
              modelId: params.modelId,
              // Omitted for Default — the absence IS the value, so sending an
              // explicit `undefined` (or `""`) would be a different thing on the
              // wire from what the role means.
              ...(params.reasoningEffort !== undefined
                ? { reasoningEffort: params.reasoningEffort }
                : {}),
            },
    });
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent
        className="rounded-lg border-(--color-border-secondary) max-w-lg w-full md:mx-4"
        data-testid="role-editor"
      >
        <DialogHeader>
          <DialogTitle>{role ? `Edit ${role.name}` : "New role"}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3 px-5 pb-1">
          {/*
            The reviewer has no name field at all (req 2). Rendering one disabled
            would say the name is a setting that happens to be locked; it is not
            a setting — "review this" has to keep resolving to something.
          */}
          {!reserved && (
            <Field label="Name">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="deep-dive"
                className={INPUT_CLASS}
                data-testid="role-editor-name"
                autoFocus
              />
            </Field>
          )}

          <Field label="Description" hint="Optional — what this role is for.">
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="The thorough one"
              className={INPUT_CLASS}
              data-testid="role-editor-description"
            />
          </Field>

          <Field
            label="Standing instructions"
            hint="Optional — added to whatever task the role is given."
          >
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              placeholder="Check the code against requirements.md, and report only."
              className={`${INPUT_CLASS} resize-y font-mono text-(length:--font-size-code)`}
              data-testid="role-editor-prompt"
            />
          </Field>

          {/*
            The reviewer's params are docs/261's two ranked candidate slots, not
            one tuple, so they stay on the slot cards behind this dialog (req 2).
            A single row of controls here would have to pick one of the two and
            would misreport whichever it dropped.
          */}
          {reserved ? (
            <p className="text-xs text-(--color-text-tertiary)" data-testid="role-editor-auto-note">
              ShipIt chooses what the reviewer runs on, per review — whichever configured reviewer
              is furthest from the model that wrote the work. Set the two candidates on the cards
              behind this dialog.
            </p>
          ) : params ? (
            <Field label="Runs on">
              <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-(--color-border-secondary) p-1.5">
                <ServiceSelector
                  services={services}
                  selected={params}
                  onChange={changeService}
                  disabled={busy}
                  idPrefix="role-editor"
                  fallbackLabel={params.serviceId}
                />
                <Picker
                  label={modelLabel}
                  ariaLabel="Model for this role"
                  triggerTestId="role-editor-model-trigger"
                  menuTestId="role-editor-model-menu"
                  menuWidth="w-72"
                  disabled={busy}
                  whenEmpty="readout"
                >
                  {serviceModels.map((model) => (
                    <PickerOption
                      key={`${model.serviceId}:${model.billingMode}:${model.modelId}`}
                      label={model.label}
                      selected={model.modelId === params.modelId}
                      onSelect={() => moveTo(model)}
                      testId={`role-editor-model-option-${model.modelId}`}
                    />
                  ))}
                </Picker>
                <HarnessControl
                  harnesses={harnesses}
                  selected={params.harnessId}
                  busy={busy}
                  onChange={changeHarness}
                />
                {/*
                  The level's options come from the harness the ROLE names, not
                  from a derived one — the whole reason req 6 makes the harness
                  part of a role.

                  **"Default" leads the list, exactly as it does in the
                  composer.** It is a level the user picks, not a blank: the role
                  stores no level and the harness runs at its own. Offering a
                  different option set here from the one the same knob shows
                  beside the message box was the inconsistency this fixes
                  (docs/264 req 1's resolved question).

                  A harness this install no longer has declares nothing, so the
                  stored level is shown as text rather than as a menu of one
                  wrong answer — but Default still reads as "Default" there,
                  since it needs no harness to mean what it means.
                */}
                {harness?.reasoning && harness.reasoning.options.length > 0 ? (
                  <Picker
                    label={levelLabel(harness.reasoning.options, params.reasoningEffort)}
                    icon={<BrainIcon size={ICON_SIZE.XS} className="text-(--color-text-tertiary)" />}
                    ariaLabel={`${harness.reasoning.label} for this role`}
                    triggerTestId="role-editor-reasoning-trigger"
                    menuTestId="role-editor-reasoning-menu"
                    menuLabel={harness.reasoning.label}
                    menuWidth="w-48"
                    disabled={busy}
                  >
                    {[{ value: undefined, label: DEFAULT_LEVEL_LABEL }, ...harness.reasoning.options]
                      .map((option) => (
                        <PickerOption
                          key={option.value ?? "__default__"}
                          label={option.label}
                          selected={option.value === params.reasoningEffort}
                          onSelect={() =>
                            setParams((prev) =>
                              prev ? { ...prev, reasoningEffort: option.value } : prev,
                            )
                          }
                          testId={`role-editor-reasoning-option-${option.value ?? "default"}`}
                          indent
                        />
                      ))}
                  </Picker>
                ) : (
                  <Readout testId="role-editor-reasoning-readout">
                    {params.reasoningEffort ?? DEFAULT_LEVEL_LABEL}
                  </Readout>
                )}
              </div>
            </Field>
          ) : (
            <p className="text-xs text-(--color-warning)" data-testid="role-editor-no-models">
              Nothing to run a role on yet — add a service credential under Services first.
            </p>
          )}

          {error && (
            <p
              className="flex items-start gap-1.5 text-xs text-(--color-error)"
              data-testid="role-editor-error"
            >
              <WarningIcon size={ICON_SIZE.XS} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </p>
          )}
        </div>

        <DialogFooter className="mt-3 gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} data-testid="role-editor-cancel">
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!canSave}
            onClick={submit}
            data-testid="role-editor-save"
          >
            {busy ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The harness (req 6): a picker where the model has a choice, a readout where it
 * has one, the stored id where it has none.
 *
 * All three render *something*, from day one, because a role's harness is part
 * of what it is — hiding it until it becomes selectable would misrepresent the
 * role.
 */
function HarnessControl({
  harnesses,
  selected,
  busy,
  onChange,
}: {
  harnesses: HarnessChoice[];
  selected: string;
  busy: boolean;
  onChange: (choice: HarnessChoice) => void;
}) {
  const current = harnesses.find((h) => h.id === selected);
  /**
   * A stored harness that is not among the valid ones is the field the row
   * called invalid, so it has to be **repairable here** — even when exactly one
   * replacement exists.
   *
   * Cross-agent review found this: a DeepSeek role pinned to Codex, on an
   * install where Codex is later uninstalled, left `claude` as the only valid
   * harness and rendered `codex` as an inert readout. The role could then only
   * be repaired sideways, by re-picking the same model to make `moveTo` move
   * the harness — which is not "keeps its edit controls" in any useful sense.
   */
  const needsRepair = harnesses.length > 0 && !current;
  if (harnesses.length > 1 || needsRepair) {
    return (
      <Picker
        label={current?.name ?? selected}
        ariaLabel="Harness for this role"
        triggerTestId="role-editor-harness-trigger"
        menuTestId="role-editor-harness-menu"
        menuLabel="Runs under"
        menuWidth="w-56"
        disabled={busy}
      >
        {harnesses.map((choice) => (
          <PickerOption
            key={choice.id}
            label={choice.name}
            selected={choice.id === selected}
            onSelect={() => onChange(choice)}
            testId={`role-editor-harness-option-${choice.id}`}
          />
        ))}
      </Picker>
    );
  }
  return (
    <Readout testId="role-editor-harness-readout" warn={harnesses.length === 0}>
      {current?.name ?? selected}
    </Readout>
  );
}

function Readout({
  children,
  testId,
  warn,
}: {
  children: React.ReactNode;
  testId: string;
  warn?: boolean;
}) {
  return (
    <span
      className={`px-2.5 py-1.5 text-xs font-medium ${
        warn ? "text-(--color-warning)" : "text-(--color-text-tertiary)"
      }`}
      data-testid={testId}
    >
      {children}
    </span>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-(--color-text-primary) mb-1">
        {label}
        {hint && <span className="ml-1.5 font-normal text-(--color-text-tertiary)">{hint}</span>}
      </label>
      {children}
    </div>
  );
}

/**
 * What the editor opens on.
 *
 * For an existing pinned role that is the **stored tuple, verbatim**, whether or
 * not it still resolves — the unresolved case is exactly when a picker-based UI
 * silently substitutes the first available value, and the user would then save a
 * role they never chose. For a new role it is the first eligible model with its
 * first valid harness, which is a proposal the user can see and change.
 */
function initialParams(
  role: RoleView | undefined,
  models: EligibleModelOption[],
  agents: AgentOption[],
): DraftParams | undefined {
  if (role?.params.kind === "pinned") {
    const { harnessId, serviceId, billingMode, modelId, reasoningEffort } = role.params;
    // **Verbatim, including an absent level** — `undefined` IS the draft's
    // Default, the same encoding every other line in this file uses.
    //
    // Not `?? ""`, which is what docs/274 put here when a stored absent level
    // only ever meant "this harness declares none". It breaks twice now that
    // absent means Default on any harness: `levelLabel` finds no option whose
    // value is `""` and renders the trigger EMPTY, and `submit` tests
    // `!== undefined`, so it would send `reasoningEffort: ""` — which the server
    // refuses outright ("must be a non-empty string, or omitted for Default").
    // Opening an existing Default role and pressing Save would fail.
    return { harnessId, serviceId, billingMode, modelId, reasoningEffort };
  }
  if (role) return undefined; // the reviewer — its params are the two slot cards
  const first = models[0];
  if (!first) return undefined;
  const valid = harnessesForModel(agents, first);
  const harnessId = valid[0]?.id ?? "";
  return {
    harnessId,
    serviceId: first.serviceId,
    billingMode: first.billingMode,
    modelId: first.modelId,
    // A new role opens at **Default**, not at whichever level the harness
    // happens to declare first. The old first-option pick meant a new Claude
    // role silently opened on "Low" and a new Codex one on "None" — an
    // arbitrary answer to a question the user had not been asked.
    reasoningEffort: undefined,
  };
}

/**
 * The level to hold when the harness changes: the current one where the new
 * harness declares it, else **Default**.
 *
 * Falling back to Default rather than to the harness's first option keeps this
 * honest about what it does not know. The user picked "high" on a harness that
 * is going away; the new harness not declaring "high" says nothing about which
 * of ITS levels they would have wanted, so the editor drops to the one answer
 * that needs no guess and shows it.
 */
function effortFor(
  harnesses: HarnessChoice[],
  harnessId: string,
  current: string | undefined,
): string | undefined {
  if (current === undefined) return undefined;
  const options = harnesses.find((h) => h.id === harnessId)?.reasoning?.options ?? [];
  if (options.length === 0) return undefined;
  return options.some((o) => o.value === current) ? current : undefined;
}

/** A level's display label, with `undefined` reading as "Default". */
function levelLabel(
  options: { value: string; label: string }[],
  current: string | undefined,
): string {
  if (current === undefined) return DEFAULT_LEVEL_LABEL;
  return options.find((o) => o.value === current)?.label ?? current;
}
