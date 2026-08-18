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
import { getHarness, getModel } from "../../shared/catalogue/index.js";
import { harnessesForSelection } from "../non-turn-model.js";
import {
  listConfiguredCredentials,
  type ServiceRoutingCredentialSource,
} from "../service-routing.js";
import {
  REVIEWER_DEFAULT_EFFORT,
  resolveReviewerSlots,
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
  return resolveReviewerSlots(modelDeps).map(toSlotView);
}

/**
 * Turn one edit into the complete pin to store, or throw a `ServiceError`
 * naming what is wrong with it.
 *
 * Three ways an edit is refused, and each is a different mistake:
 *
 *  - the triple names no catalogue row, or no **installed, credentialed**
 *    harness can run it — a pin that would fail on every review, and one the UI
 *    never offers, so it is API misuse rather than a state to persist;
 *  - the reasoning level is not one the derived harness declares. docs/217's
 *    rule elsewhere is "an unrecognized level means pass no flag", which here
 *    would be a level silently *replaced* — the same failure as one silently
 *    supplied, so it is refused instead;
 *  - the level is omitted, which is **not** a refusal: it is the model-changed
 *    case, and the harness's ShipIt-authored review default completes the tuple.
 *
 * The harness derivation is deliberately the implementer-independent one
 * (`harnessesForSelection` with no `avoidHarnessId`): a *setting* has to have
 * one answer whether or not a session is in front of the user. The review-time
 * preference for a harness that is not the implementer's is applied per review,
 * in `selectReviewer` — which is also why the level validated here follows the
 * derived harness rather than the one a given review ends up on.
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
  const reasoning = getHarness(runnable.harnessId)?.capabilities.reasoning;
  const options = reasoning?.options ?? [];
  // A harness with an EMPTY option set pins without a level (docs/274 req 8) —
  // there is none to name. This used to be a 400, on the reading that a
  // levelless reviewer is an incomplete one; with Grok Build shipping such a
  // harness it would have refused to pin a perfectly runnable reviewer. What
  // stays a 400 is naming a level anyway: that is a claim about the harness that
  // is false, and silently dropping it would make the Settings screen report a
  // pin the user did not make.
  if (options.length === 0) {
    if (patch.reasoningEffort !== undefined) {
      throw new ServiceError(
        400,
        `${runnable.harnessId} declares no reasoning levels, so a reviewer on it cannot name one`,
      );
    }
    return selectionOf(patch);
  }
  if (patch.reasoningEffort === undefined) {
    const derived = defaultReviewerEffort(runnable.harnessId);
    if (!derived) {
      throw new ServiceError(
        400,
        `${runnable.harnessId} declares no reasoning levels, so a reviewer on it cannot name one (docs/261 req 5)`,
      );
    }
    return { ...selectionOf(patch), reasoningEffort: derived };
  }
  if (!options.some((option) => option.value === patch.reasoningEffort)) {
    throw new ServiceError(
      400,
      `${patch.reasoningEffort} is not a reasoning level ${runnable.harnessId} offers`,
    );
  }
  return { ...selectionOf(patch), reasoningEffort: patch.reasoningEffort };
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
function defaultReviewerEffort(harnessId: AgentId): string | undefined {
  const options = getHarness(harnessId)?.capabilities.reasoning?.options ?? [];
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

function toSlotView(resolution: ReviewerSlotResolution): ReviewerSlotView {
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
  const reasoningLabel = harness?.capabilities.reasoning?.options.find(
    (option) => option.value === target.reasoningEffort,
  )?.label;
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
    },
  };
}
