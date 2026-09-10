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

export interface ReviewerSettingsDeps {
  credentialStore?: ReviewerModelDeps["credentialStore"] | undefined;
  providerAccountManager?: ReviewerModelDeps["providerAccountManager"];
  env?: NodeJS.ProcessEnv | undefined;
}

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

// Settings resolve independently of the implementer; each review derives its own harness.
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
  // Reasoning support depends on the selection, including its billing mode.
  const options = reasoningOptionsFor(runnable.harnessId, patch);
  if (options.length === 0) return selectionOf(patch);
  const kept =
    patch.reasoningEffort !== undefined
    && options.some((option) => option.value === patch.reasoningEffort);
  const effort = kept ? patch.reasoningEffort : defaultReviewerEffort(runnable.harnessId, patch);
  return { ...selectionOf(patch), ...(effort !== undefined ? { reasoningEffort: effort } : {}) };
}

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

export function requireReviewerSlot(raw: string): ReviewerSlot {
  if (raw !== "first" && raw !== "second") {
    throw new ServiceError(400, `Unknown reviewer slot: ${raw}`);
  }
  return raw;
}

function selectionOf(patch: ReviewerPinPatch) {
  return { serviceId: patch.serviceId, billingMode: patch.billingMode, modelId: patch.modelId };
}

function defaultReviewerEffort(harnessId: AgentId, selection: ModelSelection): string | undefined {
  const options = reasoningOptionsFor(harnessId, selection);
  const authored = REVIEWER_DEFAULT_EFFORT[harnessId];
  if (authored && options.some((option) => option.value === authored)) return authored;
  return options[0]?.value;
}

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
  const reasoningLabel = reasoningOptionsFor(target.harnessId, target.selection).find(
    (option) => option.value === target.reasoningEffort,
  )?.label;
  // Report substitutions from the pin across all eligible harnesses, not just this resolution.
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
