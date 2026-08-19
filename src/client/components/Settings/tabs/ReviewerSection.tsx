/**
 * docs/261 phase 3 (reqs 1, 5, 8) — where the user configures **who reviews the
 * work**.
 *
 * Until this tab existed the reviewer was half a setting: a per-harness stored
 * default supplied the model and the level, and the agent supplied the harness
 * itself by writing `--agent codex`, because a line in `CLAUDE.md` told it to.
 * Here the whole reviewer is one thing the user configures once (req 1), and
 * there are two of them so reviewing works whichever model is implementing
 * (req 4).
 *
 * Four decisions you can read straight off the markup:
 *
 *  - **Each slot says whether it is `Auto-configured` or `Pinned`, and what it
 *    currently resolves to** (req 8). That is a requirement, not a badge: a
 *    reviewer that changed because a service was added has to be legible rather
 *    than surprising, and the state is what tells the user their untouched slot
 *    is still following the install.
 *  - **The derived default is a labelled option, not a blank.** The first row
 *    of the model menu names what auto-configuration resolves to today. An
 *    empty picker that silently works is exactly what this replaces.
 *  - **The server sends the resolution; this file never re-derives it.** Which
 *    harness runs a model (req 3), which level it reviews at (req 5) and which
 *    slot is furthest from the implementer (req 4) are all the server's rules.
 *    A second implementation here is how the tab starts promising something
 *    other than what reviews.
 *  - **Pinning is atomic** (req 8). Editing *either* control pins the whole
 *    resolved tuple, and *Reset to auto* is the only way back. A half-pinned
 *    slot — a pinned level over a still-derived model — is not expressible, on
 *    the wire or here.
 *
 * **docs/264 phase 2 made this a SECTION rather than a tab.** The tab it used to
 * own is now `RolesTab`, which renders this below the list of pinned roles: the
 * reviewer is one role among many (docs/264-agent-roles req 2), and the only one whose
 * params are two ranked candidates rather than one tuple — which is exactly why
 * it keeps its own cards instead of becoming a row. Nothing below changed;
 * the outer padding and scroll container moved to the tab.
 *
 * **Phase 6 (reqs 11, 12, 13) changed what is selectable here.** The tab shipped
 * with the service as a *report* — named on the resolution line, and again as a
 * group header inside one flat menu holding every eligible model of every
 * service. Now the service is its own control carrying its billing-mode pill
 * (req 11), the model menu lists only that service's models (req 12), and all
 * three controls are the shared `Picker` the composer renders (req 13). What a
 * reviewer *is* did not change: still `(service, billing mode, model)` plus a
 * level, still one atomic pin.
 */

import { useRef, useState, type ReactNode } from "react";
import { ArrowCounterClockwiseIcon, BrainIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../../design-tokens.js";
import { Badge } from "../../ui/badge.js";
import { Button } from "../../ui/button.js";
import { Picker, PickerOption } from "../../pickers/Picker.js";
import { ServiceSelector } from "../../pickers/ServiceSelector.js";
import {
  eligibleModelsOf,
  modelAfterServiceChange,
  modelsOfService,
  servicesOf,
  canonicalKeyOf,
  type ServiceChoice,
} from "../../pickers/model-choice.js";
import { BillingModePill } from "../../BillingModePill.js";
import { reasoningOptionsFor } from "../../../../server/shared/catalogue/index.js";
import { useSettingsStore } from "../../../stores/settings-store.js";
import { useUiStore } from "../../../stores/ui-store.js";
import type { AgentOption, EligibleModelOption } from "../../../agent-types.js";
import type {
  ReviewerPinPatch,
  ReviewerSlotView,
} from "../../../../server/shared/types/agent-types.js";

/**
 * Re-read the reviewer slots from the server.
 *
 * Used only after an ambiguous write failure: a dropped connection cannot say
 * whether the server committed, so the tab asks rather than keeping a value
 * that may already be wrong. Failing quietly is right here — this runs behind a
 * toast that already reported the real problem, and a second toast about the
 * reconciliation would name a symptom rather than a cause.
 */
async function refetchReviewers(): Promise<void> {
  try {
    const res = await fetch("/api/bootstrap");
    if (!res.ok) return;
    const data = (await res.json()) as { settings?: { reviewers?: ReviewerSlotView[] } };
    if (data.settings?.reviewers) useSettingsStore.getState().setReviewers(data.settings.reviewers);
  } catch {
    // Still offline. The next `agent_list` push or reload reconciles.
  }
}

const SLOT_TITLE: Record<string, string> = {
  first: "Reviewer 1",
  second: "Reviewer 2",
};

/** The reasoning levels the slot's *derived* harness offers, or none. */
function reasoningFor(agents: AgentOption[], harnessId: string | undefined) {
  if (!harnessId) return undefined;
  return agents.find((a) => a.id === harnessId)?.reasoning;
}

export function ReviewerSection({
  agentList = [],
  metadata,
}: {
  agentList?: AgentOption[];
  /**
   * docs/264 phase 2 (reqs 8, 9) — the reviewer's description and standing
   * instructions, which are ordinary role metadata and editable like any other
   * role's. Rendered between the section's own prose and the two slot cards,
   * because it describes the reviewer rather than either candidate.
   *
   * A slot rather than state of this file's own: what the reviewer IS lives in
   * the roles list, and the editor that writes it belongs to `RolesTab`. Passing
   * the node keeps this file about the two ranked candidates, which is the one
   * thing here that is not shaped like every other role.
   */
  metadata?: ReactNode;
}) {
  const reviewers = useSettingsStore((s) => s.reviewers);
  /**
   * The slots with a write in flight — a SET, not one slot id.
   *
   * A single slot id looked sufficient because a user edits one control at a
   * time, and it is not: starting a second write overwrites the first slot's id,
   * so the first control re-enables mid-flight, and whichever request finishes
   * first clears the flag for the one still running. Cross-backend review found
   * it. The two slots are independently editable, so busy is per slot.
   */
  const [saving, setSaving] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * Which write is the newest. Every response replaces BOTH slots (slot 2 ranks
   * against slot 1), so an older response landing last would overwrite a newer
   * snapshot with a stale one — the classic last-response-wins, and here it
   * silently un-does an edit the user watched succeed. A response is applied
   * only if no later write has started since it was issued.
   */
  const latestWrite = useRef(0);
  // One list, split by the two controls that read it (reqs 11, 12): the services
  // fill the first menu, and the second shows only what the chosen one offers.
  const models = eligibleModelsOf(agentList);
  const services = servicesOf(models);

  /**
   * Write one slot and adopt the server's answer for BOTH.
   *
   * Nothing is optimistic here, unlike `BackgroundWorkSection`'s pin. Two
   * reasons, and the second is the requirement: the resolution carries a
   * derived harness and a derived level this file must not guess (req 8's "the
   * server sends the resolution"), and slot 2 is ranked *against* slot 1, so
   * editing one slot legitimately changes what the other reports. A local guess
   * would have to reimplement the ranking to stay honest.
   */
  const save = async (slot: string, value: ReviewerPinPatch | null) => {
    const write = ++latestWrite.current;
    setSaving((prev) => new Set(prev).add(slot));
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewers: { [slot]: value } }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const result = (await res.json()) as { reviewers?: ReviewerSlotView[] };
      if (result.reviewers && write === latestWrite.current) {
        useSettingsStore.getState().setReviewers(result.reviewers);
      }
    } catch (err) {
      useUiStore.getState().setToast({
        message: err instanceof Error ? err.message : "Failed to update the reviewer",
      });
      console.error("[settings] set reviewer failed:", err);
      // A failure is AMBIGUOUS — the connection can drop after the server
      // committed — so the store is not left holding a guess. Re-read what the
      // server actually has rather than assuming the write did or did not land.
      if (write === latestWrite.current) void refetchReviewers();
    } finally {
      setSaving((prev) => {
        const next = new Set(prev);
        next.delete(slot);
        return next;
      });
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="reviewer-tab">
      <div>
        <h3 className="text-sm font-medium text-(--color-text-primary)">Reviewer</h3>
        <p className="mt-0.5 text-xs text-(--color-text-tertiary)">
          Who ShipIt asks for a second opinion when an agent requests a review. Two of them, so
          reviewing works whichever model is implementing — ShipIt uses whichever is furthest
          from the model that wrote the work, preferring a different model family above
          everything else. Left alone, a reviewer follows this install: add a service and it
          improves on its own.
        </p>
      </div>

      {metadata}

      {reviewers.length === 0 ? (
        <div
          className="rounded-md border border-dashed border-(--color-border-secondary) p-6 text-center"
          data-testid="reviewer-loading"
        >
          <p className="text-sm text-(--color-text-secondary)">Loading reviewers…</p>
        </div>
      ) : (
        reviewers.map((view) => (
          <ReviewerSlotCard
            key={view.slot}
            view={view}
            models={models}
            services={services}
            reasoning={reasoningFor(agentList, view.resolved?.harnessId)}
            busy={saving.has(view.slot)}
            onSave={(value) => void save(view.slot, value)}
          />
        ))
      )}
    </div>
  );
}

function ReviewerSlotCard({
  view,
  models,
  services,
  reasoning,
  busy,
  onSave,
}: {
  view: ReviewerSlotView;
  models: EligibleModelOption[];
  services: ServiceChoice[];
  reasoning: AgentOption["reasoning"];
  busy: boolean;
  onSave: (value: ReviewerPinPatch | null) => void;
}) {
  const { resolved } = view;
  const pinned = view.source === "pinned";
  /**
   * docs/274 req 14 — the levels this reviewer's SELECTION honours.
   *
   * Not `reasoning.options`, which is the harness's vocabulary: a harness can
   * declare levels and send none on a given row (grok, key-billed), and
   * `resolveReviewerPinPatch` refuses a level in exactly that case — so reading
   * the vocabulary here renders a menu whose every value comes back a 400.
   */
  const reviewerLevels = () =>
    resolved
      ? reasoningOptionsFor(resolved.harnessId, {
          serviceId: resolved.serviceId,
          billingMode: resolved.billingMode,
          modelId: resolved.modelId,
        })
      : [];
  // Req 12's bound: the model menu shows one service's models, not the whole
  // catalogue. An unresolved slot has no service, so it offers no models either
  // — the service control is the one to use first, which is the order the
  // controls sit in.
  const serviceModels = modelsOfService(models, resolved);
  // What the slot holds now, for the service switch to preserve. The eligible
  // row when there is one; otherwise the resolution or the pin itself, whose
  // identity `canonicalKeyOf` recovers from the catalogue. That fallback is the
  // unavailable-pin case, which is precisely when a user re-points the slot at a
  // service that survived — cross-backend review found it silently taking the
  // new service's first model there.
  const currentModel =
    serviceModels.find((m) => m.modelId === resolved?.modelId) ?? resolved ?? view.pin;

  /**
   * Changing the service pins the whole tuple, like every other edit here.
   *
   * The level rides along only when the model stayed the same. A different
   * model may resolve on a different harness with a different level set, and
   * deriving that in the browser is the re-derivation req 8 rules out — so the
   * patch omits it and the server completes the tuple from the harness it
   * derives.
   *
   * "The same model" is the canonical key, not the id: moving Opus 5 from
   * Anthropic to a gateway changes the id and nothing else, and dropping the
   * level there would silently downgrade a level the user pinned deliberately —
   * which is the one thing req 5 rules out. If the level does not survive the
   * derived harness the server refuses and says so, which is visible and
   * recoverable in a way a silent replacement is not.
   */
  const changeService = (service: ServiceChoice) => {
    const next = modelAfterServiceChange(currentModel, modelsOfService(models, service));
    if (!next) return;
    const currentKey = canonicalKeyOf(currentModel);
    const keptModel = !!currentKey && next.canonicalModelKey === currentKey;
    onSave({
      serviceId: next.serviceId,
      billingMode: next.billingMode,
      modelId: next.modelId,
      ...(keptModel && resolved?.reasoningEffort
        ? { reasoningEffort: resolved.reasoningEffort }
        : {}),
    });
  };

  // The derived answer, named. Rendered even on a pinned slot — as the *Reset
  // to auto* affordance's subject — because "what would happen if I un-pinned
  // this" is not otherwise visible, and req 8's promise is that the state is
  // legible.
  const autoDetail = pinned
    ? "follow this install again"
    : resolved
      ? `${resolved.serviceName} · ${resolved.label}`
      : "nothing runnable yet";

  return (
    <div
      className="shrink-0 overflow-hidden rounded-md border border-(--color-border-secondary)"
      data-testid={`reviewer-slot-${view.slot}`}
    >
      <div className="space-y-3 p-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-medium text-(--color-text-primary)">
                {SLOT_TITLE[view.slot] ?? view.slot}
              </h3>
              {/*
                Req 8's visible state. `info` for pinned and the neutral grey
                for auto-configured, because auto is the resting state and a
                coloured badge on it would read as a warning about the case
                nobody has touched.
              */}
              <Badge
                variant={pinned ? "info" : "default"}
                className="px-1.5 text-[10px]"
                data-testid={`reviewer-state-${view.slot}`}
              >
                {pinned ? "Pinned" : "Auto-configured"}
              </Badge>
            </div>
            {/*
              Req 8's other half — what the slot currently resolves to, in one
              line: service, billing mode, model, the DERIVED harness (req 3)
              and the reasoning level (req 5). All four, because a reviewer that
              named a model and left the harness or the level unsaid is exactly
              the half-configured thing this feature replaces.

              The billing pill sits beside the service name, the way a service
              card states the same pair — a model is selected by `(service,
              billing mode, model)`, so the mode qualifies the service rather
              than the row.

              **The harness is a PREDICTION, and it is worded as one.** The
              service, the billing mode and the model are settled — the slot
              names them, or `resolveReviewerSlots` derives them once and every
              review uses that answer. The harness does not settle here. This
              view is implementer-independent by design — `resolveSlotPlan(plan,
              …, undefined)` — while review time passes the implementer's
              harness as `avoidHarnessId`, so a model both harnesses can carry
              resolves to the picker's first harness HERE and to the other one
              THERE. Stating it flat ("running on Claude Code") read as a
              promise that a Codex review then broke, and the user reported it
              as their settings change failing to apply.

              **The reasoning level is a second, latent prediction — left
              stated flat here deliberately.** `buildTarget` sets it to
              `plan.pin?.reasoningEffort ?? defaultEffortFor(candidate.harnessId)`
              against the review-time harness, so an auto slot's level follows
              whichever harness the review bent to (invisible only because both
              harnesses currently default to `high`), and a pinned slot's level
              is validated against the harness derived HERE and then copied onto
              the one derived THERE — a level the second harness may not declare
              at all. That is planning#381, which owns the choice between
              refusing and substituting; hedging the level before that choice is
              made would describe behaviour ShipIt has not settled on. So the
              defect is named here rather than papered over in the copy.

              So the rule is stated and the value is given as its no-conflict
              case. Dropping the harness instead would have been the smaller
              diff and the wrong one: `--agent codex` in a repository's
              CLAUDE.md is the half-configured thing this feature took away, and
              Settings is where the reviewers are supposed to explain
              themselves. A reviewer screen silent about the harness gives the
              axis back to nobody.
            */}
            <div
              className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-(--color-text-tertiary)"
              data-testid={`reviewer-resolution-${view.slot}`}
            >
              {resolved ? (
                <>
                  <span>Currently {resolved.serviceName}</span>
                  <BillingModePill
                    billingMode={resolved.billingMode}
                    data-testid={`reviewer-mode-pill-${view.slot}`}
                  />
                  <span>
                    · {resolved.label} at{" "}
                    {resolved.reasoningLabel ?? resolved.reasoningEffort}
                  </span>
                  {/*
                    "preferring", not "differing": `harnessesPreferring` moves
                    the avoided harness to the BACK of the search rather than
                    removing it, so a review can still land on it when it is the
                    only routable one. And the named value is qualified by "with
                    no session to avoid" because that is literally this view's
                    derivation (`avoidHarnessId: undefined`) — not by "unless the
                    reviewed session is on it", which would promise a switch that
                    the fallback does not guarantee.
                  */}
                  <span data-testid={`reviewer-harness-${view.slot}`}>
                    · harness selected per review, preferring one the reviewed session is
                    not on — {resolved.harnessName} with no session to avoid
                  </span>
                </>
              ) : view.unavailableReason === "pin_unavailable" ? (
                <span className="text-(--color-warning)">
                  {view.pin?.modelId} is no longer available — its credential or its harness is
                  gone. Reviews fall through to the other reviewer until you pick another.
                </span>
              ) : (
                <span>Nothing to review with yet — add a service credential under Services.</span>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/*
            First control, first question: who pays (req 11). It is deliberately
            ahead of the model, because it is what bounds the model list — and
            because "is this my subscription or my card" is answerable here
            without opening anything.
          */}
          <ServiceSelector
            services={services}
            selected={resolved}
            onChange={changeService}
            disabled={busy}
            idPrefix={`reviewer-${view.slot}`}
          />
          {/*
            req 14 — no models, no control. The auto row alone is not a choice:
            it restates the state the card's own line above already reports, and
            on an install with no service that is the whole menu. The *Reset to
            auto* button below stays, so a slot pinned to a model whose
            credential went away can still be un-pinned with nothing to pick.
          */}
          {serviceModels.length > 0 && (
            <ModelMenu
              slot={view.slot}
              models={serviceModels}
              autoDetail={autoDetail}
              pinned={pinned}
              triggerLabel={resolved ? resolved.label : (view.pin?.modelId ?? "Unavailable")}
              disabled={busy}
              selected={pinned ? resolved?.modelId : undefined}
              onPick={(model) =>
                onSave({
                  serviceId: model.serviceId,
                  billingMode: model.billingMode,
                  modelId: model.modelId,
                  // The level is deliberately OMITTED. The model may resolve on a
                  // different harness with a different level set, and which
                  // harness that is (req 3) is the server's derivation — guessing
                  // it here is the re-derivation req 8 rules out. The server
                  // completes the tuple from the harness it derives, so the pin
                  // stays atomic either way.
                })
              }
              onReset={() => onSave(null)}
            />
          )}

          {/* docs/274 req 14 — the levels THIS reviewer's selection honours, not
              the harness's raw vocabulary. A harness can declare levels and send
              none on a given row (grok, key-billed), and the server refuses such
              a pin — so offering it here would render a control whose every
              value comes back a 400. */}
          {reasoning && reviewerLevels().length > 0 && (
            <ReasoningMenu
              slot={view.slot}
              label={reasoning.label}
              options={reviewerLevels()}
              current={resolved?.reasoningEffort}
              disabled={busy || !resolved}
              onPick={(effort) => {
                if (!resolved) return;
                // Editing the level pins the WHOLE tuple (req 8), which is why
                // the model triple rides along rather than being left to a
                // partial patch.
                onSave({
                  serviceId: resolved.serviceId,
                  billingMode: resolved.billingMode,
                  modelId: resolved.modelId,
                  reasoningEffort: effort,
                });
              }}
            />
          )}

          {pinned && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => onSave(null)}
              data-testid={`reviewer-reset-${view.slot}`}
            >
              <ArrowCounterClockwiseIcon size={ICON_SIZE.XS} />
              Reset to auto
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The model, bounded by the chosen service (req 12).
 *
 * No group headers any more: with the service chosen on its own control, every
 * row here belongs to it, and a header repeating the service on each row would
 * be stating the answer to a question the user has already been asked.
 */
function ModelMenu({
  slot,
  models,
  autoDetail,
  pinned,
  triggerLabel,
  selected,
  disabled,
  onPick,
  onReset,
}: {
  slot: string;
  models: EligibleModelOption[];
  autoDetail: string;
  pinned: boolean;
  triggerLabel: string;
  /** The pinned model id, or undefined on an auto-configured slot. */
  selected: string | undefined;
  disabled: boolean;
  onPick: (model: EligibleModelOption) => void;
  onReset: () => void;
}) {
  return (
    <Picker
      label={triggerLabel}
      ariaLabel={`Model for ${SLOT_TITLE[slot] ?? slot}`}
      triggerTestId={`reviewer-model-trigger-${slot}`}
      menuTestId={`reviewer-model-menu-${slot}`}
      menuWidth="w-72"
      disabled={disabled}
    >
      {/*
        The derived default as a LABELLED option (req 8), always first and never
        a blank. On an auto slot it names what auto currently resolves to; on a
        pinned slot it is the way back. The second line is `PickerOption`'s
        `detail` — on one line the resolved value is what gets truncated, which
        turns the labelled option back into the bare "Auto-configured" the
        requirement exists to replace.
      */}
      <PickerOption
        label="Auto-configured"
        detail={autoDetail}
        selected={!pinned}
        onSelect={onReset}
        testId={`reviewer-model-auto-${slot}`}
      />
      {models.map((model) => (
        <PickerOption
          key={`${model.serviceId}:${model.billingMode}:${model.modelId}`}
          label={model.label}
          selected={selected === model.modelId}
          onSelect={() => onPick(model)}
          testId={`reviewer-model-option-${slot}-${model.modelId}`}
        />
      ))}
    </Picker>
  );
}

/**
 * The reviewer's reasoning level (req 5).
 *
 * **No "Default" entry**, unlike the composer's `ReasoningSelector`. There the
 * absence of a level means "pass no flag and let the CLI decide"; here req 5
 * makes the level part of the reviewer, so a reviewer with no level is exactly
 * the state the requirement rules out. Every option is a real level, and an
 * auto-configured slot already carries the one ShipIt authored for its harness.
 *
 * That difference is in the OPTIONS, not in the control (req 13): same trigger,
 * same rows, same brain glyph the composer's level carries.
 */
function ReasoningMenu({
  slot,
  label,
  options,
  current,
  disabled,
  onPick,
}: {
  slot: string;
  label: string;
  options: { value: string; label: string }[];
  current: string | undefined;
  disabled: boolean;
  onPick: (value: string) => void;
}) {
  const currentLabel = options.find((o) => o.value === current)?.label ?? current ?? label;
  return (
    <Picker
      label={currentLabel}
      icon={<BrainIcon size={ICON_SIZE.XS} className="text-(--color-text-tertiary)" />}
      ariaLabel={`${label} for ${SLOT_TITLE[slot] ?? slot}`}
      triggerTestId={`reviewer-reasoning-trigger-${slot}`}
      menuTestId={`reviewer-reasoning-menu-${slot}`}
      menuLabel={label}
      menuWidth="w-48"
      disabled={disabled}
    >
      {options.map((option) => (
        <PickerOption
          key={option.value}
          label={option.label}
          selected={option.value === current}
          onSelect={() => onPick(option.value)}
          testId={`reviewer-reasoning-option-${slot}-${option.value}`}
          indent
        />
      ))}
    </Picker>
  );
}
