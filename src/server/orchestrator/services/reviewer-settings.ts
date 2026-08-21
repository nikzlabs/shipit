/**
 * docs/261 phase 3 (reqs 1, 5, 8) — the reviewer settings as they cross the
 * wire, and the validation behind an edit to them.
 *
 * Phase 1 owns *what* a slot resolves to (`reviewer-model.ts`); this owns
 * turning that into something a Settings screen can render, and turning a
 * screen's edit back into a stored pin. Two rules shape it, both of them req
 * 8's:
 *
 *  - **The server sends the resolution; the client does not re-derive it.**
 *    Which harness runs a model, which level it reviews at, and which slot
 *    ranks where are reqs 3/4/5's rules. A second implementation in the browser
 *    is how the Settings screen starts promising something other than what
 *    reviews.
 *  - **Auto-configured is a state with an answer**, so a slot nobody has
 *    touched still reports a complete reviewer — model, service, harness *and*
 *    reasoning level — and the tab labels it `Auto-configured` rather than
 *    leaving a blank.
 *
 * **Pinning is atomic** (req 8), and {@link resolveReviewerPinPatch} is where
 * that is enforced for an edit: whatever field the user touched, the whole
 * resolved tuple is written. A patch may omit the reasoning level — that is the
 * "the user changed the model" case, and the level then follows the *derived*
 * harness, because the client cannot know which harness a model resolves on
 * without re-deriving req 3. Nothing else about the pin may be partial.
 */

import type { AgentId, ReviewerPin, ReviewerSlot } from "../../shared/types/agent-types.js";
import type { ModelSelection } from "../../shared/catalogue/types.js";
import { getHarness, getModel, reasoningOptionsFor } from "../../shared/catalogue/index.js";
import { harnessesForSelection } from "../non-turn-model.js";
import {
  listConfiguredCredentials,
  type ServiceRoutingCredentialSource,
} from "../service-routing.js";
import {
  REVIEWER_DEFAULT_EFFORT,
  resolveReviewerSlots,
  reviewerEffortSubstitutions,
  type ReviewerModelDeps,
  type ReviewerSlotResolution,
} from "../reviewer-model.js";
import { ServiceError } from "./types.js";
import type { ReviewerPinPatch, ReviewerSlotView } from "./types.js";

/**
 * What the reviewer payload needs.
 *
 * Declared structurally (the `Pick`s rather than the classes) for the same
 * reason `ReviewerModelDeps` is: this reads four methods, and naming the whole
 * `CredentialStore` would force every test to build one on disk to exercise a
 * pure projection. Both members are optional because two real callers hold
 * neither — the settings-read test seam, and the bootstrap failure fallback.
 */
export interface ReviewerSettingsDeps {
  credentialStore?: ReviewerModelDeps["credentialStore"] | undefined;
  providerAccountManager?: ReviewerModelDeps["providerAccountManager"];
  env?: NodeJS.ProcessEnv | undefined;
}

/**
 * Both slots, ready to render (req 8).
 *
 * Returns two entries even with no credential store at all — a `nothing_eligible`
 * pair rather than an empty array, because the tab's job is to say *which* of
 * the two reviewers has no answer, and an empty array says neither exists.
 */
export function buildReviewerSettings(deps: ReviewerSettingsDeps): ReviewerSlotView[] {
  const modelDeps = reviewerModelDeps(deps);
  if (!modelDeps) {
    return (["first", "second"] as ReviewerSlot[]).map((slot) => ({
      slot,
      source: "auto" as const,
      unavailableReason: "nothing_eligible" as const,
    }));
  }
  return resolveReviewerSlots(modelDeps).map((resolution) => toSlotView(resolution, modelDeps));
}

/**
 * Turn one edit into the complete pin to store, or throw a `ServiceError`
 * naming what is wrong with it.
 *
 * **The MODEL is refused; the LEVEL is re-derived** (planning#352). Two ways an
 * edit is refused, and both are the same mistake — a model this install cannot
 * pin:
 *
 *  - the triple names no catalogue row, or no **installed, credentialed**
 *    harness can run it — a pin that would fail on every review, and one the UI
 *    never offers, so it is API misuse rather than a state to persist.
 *
 * The level is never a refusal. Omitting it is the model-changed case, and the
 * ShipIt-authored review default for the derived selection completes the tuple.
 * Naming a level the derived selection does not offer takes the *same* answer,
 * and that is planning#352's decision applied to the settings path: a service
 * change that keeps the model can derive a different harness, and refusing there
 * made the change fail until the user lowered the level first — req 11 blocked
 * by req 5, over a level that came along with the model rather than being chosen
 * for the new one.
 *
 * That is not the silent replacement req 5 rules out, because **the response is
 * the record**: this returns the complete pin that was stored, the tab renders
 * it, and a level that changed under an edit is reported there (the tab raises a
 * toast naming both levels). Nothing is filled in where the caller cannot see
 * it, which is the property req 5 is protecting.
 *
 * The harness derivation is deliberately the implementer-independent one
 * (`harnessesForSelection` with no `avoidHarnessId`): a *setting* has to have
 * one answer whether or not a session is in front of the user. The review-time
 * preference for a harness that is not the implementer's is applied per review,
 * in `selectReviewer`, which re-derives the level again for whatever it resolves
 * onto — so a level stored here is what the setting means, not a promise about
 * every review.
 */
export function resolveReviewerPinPatch(
  patch: ReviewerPinPatch,
  credentialStore: ServiceRoutingCredentialSource,
  env?: NodeJS.ProcessEnv,
): ReviewerPin {
  if (!getModel(patch)) {
    throw new ServiceError(
      400,
      `No catalogue entry for ${patch.serviceId}/${patch.billingMode}/${patch.modelId}`,
    );
  }
  const [runnable] = harnessesForSelection(
    patch,
    listConfiguredCredentials(credentialStore, env ?? process.env),
  );
  if (!runnable) {
    throw new ServiceError(
      400,
      `No installed harness can run ${patch.serviceId}/${patch.billingMode}/${patch.modelId} with the credentials configured`,
    );
  }
  // What THIS SELECTION offers on that harness, never the harness's raw
  // vocabulary (docs/274 req 14). The two diverge for grok, and reading the
  // vocabulary here would let a reviewer be pinned to `xhigh` on a key-billed
  // row whose CLI discards the flag before the wire — a pin the Settings screen
  // would then report as in force while the review ran at the CLI's default.
  const options = reasoningOptionsFor(runnable.harnessId, patch);
  // An EMPTY option set pins without a level (docs/274 req 8) — there is none to
  // name, so a level that arrived anyway is dropped rather than refused.
  //
  // "On this selection", not "the harness declares none", and the difference is
  // req 14's: since planning#435 grok DOES declare four levels and still honours
  // none of them on a key-billed row.
  if (options.length === 0) return selectionOf(patch);
  const kept =
    patch.reasoningEffort !== undefined
    && options.some((option) => option.value === patch.reasoningEffort);
  const effort = kept ? patch.reasoningEffort : defaultReviewerEffort(runnable.harnessId, patch);
  return { ...selectionOf(patch), ...(effort !== undefined ? { reasoningEffort: effort } : {}) };
}

/**
 * A slot's whole `PUT /api/settings` value: a patch to pin, or `null` to return
 * the slot to derivation (req 8's *Reset to auto*).
 *
 * Rejected rather than coerced, because every rejection here is a caller bug:
 * the tab only ever sends a triple it was offered.
 */
export function parseReviewerPinPatch(raw: unknown, slot: string): ReviewerPinPatch | null {
  if (raw === null) return null;
  if (typeof raw !== "object") {
    throw new ServiceError(400, `reviewers.${slot} must be a pin object or null`);
  }
  const value = raw as Record<string, unknown>;
  const { serviceId, billingMode, modelId, reasoningEffort } = value;
  if (typeof serviceId !== "string" || !serviceId) {
    throw new ServiceError(400, `reviewers.${slot}.serviceId is required`);
  }
  if (billingMode !== "sub" && billingMode !== "key") {
    throw new ServiceError(400, `reviewers.${slot}.billingMode must be "sub" or "key"`);
  }
  if (typeof modelId !== "string" || !modelId) {
    throw new ServiceError(400, `reviewers.${slot}.modelId is required`);
  }
  if (reasoningEffort !== undefined && (typeof reasoningEffort !== "string" || !reasoningEffort)) {
    throw new ServiceError(400, `reviewers.${slot}.reasoningEffort must be a non-empty string`);
  }
  return {
    serviceId,
    billingMode,
    modelId,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  };
}

/** `"first"` / `"second"`, or a 400 — a slot name is never coerced. */
export function requireReviewerSlot(raw: string): ReviewerSlot {
  if (raw !== "first" && raw !== "second") {
    throw new ServiceError(400, `Unknown reviewer slot: ${raw}`);
  }
  return raw;
}

// ---- Internals -------------------------------------------------------------

function selectionOf(patch: ReviewerPinPatch) {
  return { serviceId: patch.serviceId, billingMode: patch.billingMode, modelId: patch.modelId };
}

/**
 * This harness's ShipIt-authored review level, or `undefined` when the harness
 * declares no levels at all.
 *
 * The same rule `reviewer-model.ts`'s `defaultEffortFor` applies, and it is
 * deliberately not imported from there: that one must always return a string
 * (a resolved reviewer has to be complete), while an *edit* naming a harness
 * with no levels is a refusal rather than a value to invent. Same table, two
 * honest answers.
 */
function defaultReviewerEffort(harnessId: AgentId, selection: ModelSelection): string | undefined {
  // Asked of the SELECTION (docs/274 req 14). A harness's authored default is
  // its answer to "how hard should a review think", not a claim that every row
  // it can run honours that word — grok's `high` is real on a subscription row
  // and meaningless on a key-billed one.
  const options = reasoningOptionsFor(harnessId, selection);
  const authored = REVIEWER_DEFAULT_EFFORT[harnessId];
  if (authored && options.some((option) => option.value === authored)) return authored;
  return options[0]?.value;
}

/**
 * `undefined` when there is no credential store to read — a build with no store
 * has no pins and no credentials, so "what does the reviewer resolve to" has no
 * answer rather than a derived one.
 */
function reviewerModelDeps(deps: ReviewerSettingsDeps): ReviewerModelDeps | undefined {
  if (!deps.credentialStore) return undefined;
  return {
    credentialStore: deps.credentialStore,
    ...(deps.providerAccountManager ? { providerAccountManager: deps.providerAccountManager } : {}),
    ...(deps.env ? { env: deps.env } : {}),
  };
}

function toSlotView(
  resolution: ReviewerSlotResolution,
  deps: ReviewerModelDeps,
): ReviewerSlotView {
  if (!resolution.target) {
    return {
      slot: resolution.slot,
      source: resolution.source,
      ...(resolution.source === "pinned" ? { pin: resolution.pin } : {}),
      unavailableReason: resolution.reason,
    };
  }
  const { target } = resolution;
  const harness = getHarness(target.harnessId);
  // The levels THIS SELECTION offers, not the harness's raw vocabulary (docs/274
  // req 14). The two lists carry the same label objects, so this is not a nicer
  // label — it is the honest one: a level the selection does not offer has no
  // label here, and since planning#352 no such level can reach a target anyway.
  const reasoningLabel = reasoningOptionsFor(target.harnessId, target.selection).find(
    (option) => option.value === target.reasoningEffort,
  )?.label;
  // planning#352 — a pin applies partially, so the tab reports where the pinned
  // level does not survive and what it becomes there. Computed from the PIN, not
  // from this resolution: this view names one harness and a review derives its
  // own, and the crossing is the case that matters most.
  const substitutions = resolution.pin
    ? reviewerEffortSubstitutions(resolution.pin, deps).map((entry) => ({
        harnessId: entry.harnessId,
        harnessName: getHarness(entry.harnessId)?.name ?? entry.harnessId,
        ...(entry.reasoningEffort !== undefined ? { reasoningEffort: entry.reasoningEffort } : {}),
        ...(entry.reasoningLabel ? { reasoningLabel: entry.reasoningLabel } : {}),
      }))
    : [];
  return {
    slot: resolution.slot,
    source: resolution.source,
    ...(resolution.pin ? { pin: resolution.pin } : {}),
    resolved: {
      serviceId: target.selection.serviceId,
      billingMode: target.selection.billingMode,
      modelId: target.selection.modelId,
      serviceName: target.serviceName,
      label: getModel(target.selection)?.label ?? target.selection.modelId,
      harnessId: target.harnessId,
      harnessName: harness?.name ?? target.harnessId,
      ...(target.reasoningEffort !== undefined ? { reasoningEffort: target.reasoningEffort } : {}),
      ...(reasoningLabel ? { reasoningLabel } : {}),
      ...(substitutions.length > 0 ? { effortSubstitutions: substitutions } : {}),
    },
  };
}
