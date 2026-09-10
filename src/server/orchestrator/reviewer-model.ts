import type { AgentId, ReviewerPin, ReviewerSlot, ServiceRouting } from "../shared/types.js";
import { REVIEWER_SLOTS } from "../shared/types.js";
import type { ProviderAccountManager, ProviderRoute } from "./provider-account-manager.js";
import type { CredentialStore } from "./credential-store.js";
import {
  allServices,
  getService,
  modelIdentityFor,
  nativeServiceForHarness,
  reasoningOptionsFor,
  sameCanonicalModel,
  selectionHonoursEffort,
  sameModelFamily,
  type ConfiguredCredential,
  type ModelFamily,
  type ModelIdentity,
  type ModelSelection,
} from "../shared/catalogue/index.js";
import { harnessesForSelection } from "./non-turn-model.js";
import {
  credentialSecretForRoute,
  listConfiguredCredentials,
  selectRouteForSelection,
  serviceRoutingForSelection,
  type ServiceRoutingCredentialSource,
} from "./service-routing.js";

// Defaults still require per-selection validation; some billing modes discard effort flags.
export const REVIEWER_DEFAULT_EFFORT: Record<AgentId, string | null> = {
  claude: "high",
  codex: "high",
  opencode: "high",
  grok: "high",
};

export type ReviewerSource = "pinned" | "auto";

/** Lower is further from the implementer. */
export type ReviewerTier = 1 | 2 | 3 | 4 | 5 | 6;

// Freeze one target for retries and attribution; re-resolution could name a different reviewer.
export interface ReviewerTarget {
  readonly slot: ReviewerSlot;
  readonly source: ReviewerSource;
  readonly harnessId: AgentId;
  readonly selection: Readonly<ModelSelection>;
  readonly reasoningEffort?: string;
  readonly serviceName: string;
  readonly route: Readonly<ProviderRoute>;
  readonly serviceRouting?: Readonly<ServiceRouting>;
  readonly credentialSecret?: string;
}

export type ReviewerSlotResolution =
  | { slot: ReviewerSlot; source: ReviewerSource; target: ReviewerTarget; pin?: ReviewerPin }
  | { slot: ReviewerSlot; source: "pinned"; target: null; pin: ReviewerPin; reason: "pin_unavailable" }
  | { slot: ReviewerSlot; source: "auto"; target: null; reason: "nothing_eligible" };

// Use the selection actually running after failover or retirement, not the stored pin.
export interface ImplementerContext {
  harnessId: AgentId;
  selection?: ModelSelection | undefined;
}

export type ReviewerSelection =
  | {
      ok: true;
      target: ReviewerTarget;
      tier: ReviewerTier;
      // A harness-only tier cannot establish a model-family difference.
      tierBasis: "model-and-harness" | "harness-only";
    }
  | { ok: false; reason: "no_reviewer_available" };

export interface ReviewerModelDeps {
  credentialStore: Pick<CredentialStore, "getReviewerPin"> & ServiceRoutingCredentialSource;
  providerAccountManager?:
    | Pick<ProviderAccountManager, "selectAccountForTurn" | "subscriptionLimitsFor">
    | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

// Model differences outrank harness differences; gateways can serve identical model weights.
export function reviewerDistanceTier(
  implementer: { harnessId: AgentId; identity?: ModelIdentity | undefined },
  candidate: { harnessId: AgentId; identity?: ModelIdentity | undefined },
): ReviewerTier {
  const differentHarness = candidate.harnessId !== implementer.harnessId;
  const differentFamily = !sameModelFamily(implementer.identity, candidate.identity);
  const differentModel = !sameCanonicalModel(implementer.identity, candidate.identity);

  if (differentFamily && differentHarness) return 1;
  if (differentFamily) return 2;
  if (differentModel && differentHarness) return 3;
  if (differentModel) return 4;
  if (differentHarness) return 5;
  return 6;
}

// Settings resolve independently of the implementer; only review-time harness choice bends away.
export function resolveReviewerSlots(deps: ReviewerModelDeps): ReviewerSlotResolution[] {
  const credentials = listConfiguredCredentials(deps.credentialStore, deps.env ?? process.env);
  return slotPlans(credentials, deps).map((plan) =>
    resolveSlotPlan(plan, credentials, deps, undefined),
  );
}

export function selectReviewer(
  implementer: ImplementerContext,
  deps: ReviewerModelDeps,
): ReviewerSelection {
  const credentials = listConfiguredCredentials(deps.credentialStore, deps.env ?? process.env);
  const implementerIdentity = implementer.selection
    ? modelIdentityFor(implementer.selection)
    : undefined;
  // Use the native-service family only as a tie-break when actual identity is unknown.
  const likelyFamily = implementerIdentity
    ? undefined
    : soleFamilyOfService(nativeServiceForHarness(implementer.harnessId));

  let best: { target: ReviewerTarget; tier: ReviewerTier; avoidsLikelyFamily: boolean } | undefined;
  for (const plan of slotPlans(credentials, deps)) {
    const resolved = resolveSlotPlan(plan, credentials, deps, implementer.harnessId);
    if (!resolved.target) continue;
    const candidateIdentity = modelIdentityFor(resolved.target.selection);
    const tier = reviewerDistanceTier(
      { harnessId: implementer.harnessId, identity: implementerIdentity },
      { harnessId: resolved.target.harnessId, identity: candidateIdentity },
    );
    const avoidsLikelyFamily =
      likelyFamily !== undefined
      && candidateIdentity !== undefined
      && candidateIdentity.family !== likelyFamily;
    if (beatsIncumbentReviewer({ tier, avoidsLikelyFamily }, best)) {
      best = { target: resolved.target, tier, avoidsLikelyFamily };
    }
  }
  if (!best) return { ok: false, reason: "no_reviewer_available" };
  return {
    ok: true,
    target: best.target,
    tier: best.tier,
    tierBasis: implementerIdentity ? "model-and-harness" : "harness-only",
  };
}

export function beatsIncumbentReviewer(
  candidate: { tier: ReviewerTier; avoidsLikelyFamily: boolean },
  incumbent: { tier: ReviewerTier; avoidsLikelyFamily: boolean } | undefined,
): boolean {
  if (!incumbent) return true;
  if (candidate.tier !== incumbent.tier) return candidate.tier < incumbent.tier;
  return candidate.avoidsLikelyFamily && !incumbent.avoidsLikelyFamily;
}

function soleFamilyOfService(serviceId: string | undefined): ModelFamily | undefined {
  const service = serviceId ? getService(serviceId) : undefined;
  if (!service) return undefined;
  const families = new Set(service.modes.flatMap((mode) => mode.models.map((m) => m.family)));
  const [only] = families;
  return families.size === 1 ? only : undefined;
}

interface SlotPlan {
  slot: ReviewerSlot;
  source: ReviewerSource;
  pin?: ReviewerPin;
  selection?: ModelSelection;
}

function slotPlans(
  credentials: readonly ConfiguredCredential[],
  deps: ReviewerModelDeps,
): SlotPlan[] {
  const pins = new Map<ReviewerSlot, ReviewerPin | undefined>(
    REVIEWER_SLOTS.map((slot) => [slot, deps.credentialStore.getReviewerPin(slot)]),
  );
  const derived = deriveAutoSelections(
    REVIEWER_SLOTS.filter((slot) => !pins.get(slot)),
    credentials,
    deps,
  );
  return REVIEWER_SLOTS.map((slot) => {
    const pin = pins.get(slot);
    if (pin) {
      return {
        slot,
        source: "pinned" as const,
        pin,
        selection: { serviceId: pin.serviceId, billingMode: pin.billingMode, modelId: pin.modelId },
      };
    }
    const auto = derived.get(slot);
    return auto ? { slot, source: "auto" as const, selection: auto } : { slot, source: "auto" as const };
  });
}

// First uses picker order; second ranks against the first slot, including a pinned first slot.
function deriveAutoSelections(
  slots: readonly ReviewerSlot[],
  credentials: readonly ConfiguredCredential[],
  deps: ReviewerModelDeps,
): Map<ReviewerSlot, ModelSelection> {
  const out = new Map<ReviewerSlot, ModelSelection>();
  if (slots.length === 0) return out;

  const firstPin = deps.credentialStore.getReviewerPin("first");
  let anchor: { harnessId: AgentId; identity: ModelIdentity | undefined } | undefined;

  if (slots.includes("first")) {
    const candidate = routableCandidates(credentials, deps)[0];
    if (!candidate) return out;
    out.set("first", candidate.selection);
    anchor = { harnessId: candidate.harnessId, identity: candidate.identity };
  } else if (firstPin) {
    const selection = {
      serviceId: firstPin.serviceId,
      billingMode: firstPin.billingMode,
      modelId: firstPin.modelId,
    };
    const resolved = firstRoutable(selection, credentials, deps, undefined);
    if (resolved) anchor = { harnessId: resolved.harnessId, identity: resolved.identity };
  }

  if (!slots.includes("second")) return out;
  const avoid = anchor?.harnessId;
  const candidates = routableCandidates(credentials, deps, avoid);
  if (candidates.length === 0) return out;
  if (!anchor) {
    out.set("second", candidates[0].selection);
    return out;
  }
  const anchored = anchor;
  let best: { candidate: ReviewerCandidate; tier: ReviewerTier } | undefined;
  for (const candidate of candidates) {
    const tier = reviewerDistanceTier(anchored, candidate);
    if (!best || tier < best.tier) best = { candidate, tier };
  }
  if (best) out.set("second", best.candidate.selection);
  return out;
}

interface ReviewerCandidate {
  selection: ModelSelection;
  harnessId: AgentId;
  identity: ModelIdentity | undefined;
  route: ProviderRoute;
}

function routableCandidates(
  credentials: readonly ConfiguredCredential[],
  deps: ReviewerModelDeps,
  avoidHarnessId?: AgentId,
): ReviewerCandidate[] {
  const out: ReviewerCandidate[] = [];
  for (const service of allServices()) {
    for (const mode of service.modes) {
      for (const model of mode.models) {
        const found = firstRoutable(
          { serviceId: service.id, billingMode: mode.kind, modelId: model.id },
          credentials,
          deps,
          avoidHarnessId,
        );
        if (found) out.push(found);
      }
    }
  }
  return out;
}

// An eligible harness can lack a usable route; try the others before rejecting the model.
function firstRoutable(
  selection: ModelSelection,
  credentials: readonly ConfiguredCredential[],
  deps: ReviewerModelDeps,
  avoidHarnessId: AgentId | undefined,
): ReviewerCandidate | undefined {
  const routeDeps = routeDepsOf(deps);
  for (const resolved of harnessesForSelection(selection, credentials, {
    ...(avoidHarnessId ? { avoidHarnessId } : {}),
  })) {
    const account = selectRouteForSelection(resolved.harnessId, resolved.selection, routeDeps);
    if (!account.ok) continue;
    return {
      selection: resolved.selection,
      harnessId: resolved.harnessId,
      identity: modelIdentityFor(resolved.selection),
      route: account.route,
    };
  }
  return undefined;
}

function routeDepsOf(deps: ReviewerModelDeps) {
  return {
    credentialStore: deps.credentialStore,
    ...(deps.providerAccountManager ? { providerAccountManager: deps.providerAccountManager } : {}),
    ...(deps.env ? { env: deps.env } : {}),
  };
}

function resolveSlotPlan(
  plan: SlotPlan,
  credentials: readonly ConfiguredCredential[],
  deps: ReviewerModelDeps,
  avoidHarnessId: AgentId | undefined,
): ReviewerSlotResolution {
  if (!plan.selection) {
    return plan.pin
      ? { slot: plan.slot, source: "pinned", target: null, pin: plan.pin, reason: "pin_unavailable" }
      : { slot: plan.slot, source: "auto", target: null, reason: "nothing_eligible" };
  }
  const candidate = firstRoutable(plan.selection, credentials, deps, avoidHarnessId);
  if (!candidate) {
    return plan.pin
      ? { slot: plan.slot, source: "pinned", target: null, pin: plan.pin, reason: "pin_unavailable" }
      : { slot: plan.slot, source: "auto", target: null, reason: "nothing_eligible" };
  }
  const target = buildTarget(plan, candidate, deps);
  return plan.pin
    ? { slot: plan.slot, source: plan.source, target, pin: plan.pin }
    : { slot: plan.slot, source: plan.source, target };
}

function buildTarget(
  plan: SlotPlan,
  candidate: ReviewerCandidate,
  deps: ReviewerModelDeps,
): ReviewerTarget {
  const serviceRouting = serviceRoutingForSelection(
    candidate.harnessId,
    candidate.selection,
    candidate.route,
    deps.credentialStore,
  );
  const credentialSecret = serviceRouting?.credentialSourceEnv
    ? credentialSecretForRoute(
        deps,
        candidate.selection,
        serviceRouting.credentialSourceEnv,
        candidate.route,
      )
    : undefined;
  const effort = effortFor(plan.pin?.reasoningEffort, candidate);
  return Object.freeze({
    slot: plan.slot,
    source: plan.source,
    harnessId: candidate.harnessId,
    // Freeze copies so nested mutation is blocked without freezing the caller's objects.
    selection: Object.freeze({ ...candidate.selection }),
    ...(effort !== undefined ? { reasoningEffort: effort } : {}),
    serviceName: getService(candidate.selection.serviceId)?.name ?? candidate.selection.serviceId,
    route: Object.freeze({ ...candidate.route }),
    ...(serviceRouting ? { serviceRouting: Object.freeze(serviceRouting) } : {}),
    ...(credentialSecret ? { credentialSecret } : {}),
  });
}

// A pin validated on one harness may resolve onto another that cannot use that effort.
function effortFor(pinned: string | undefined, candidate: ReviewerCandidate): string | undefined {
  if (pinned !== undefined && selectionHonoursEffort(candidate.harnessId, candidate.selection, pinned)) {
    return pinned;
  }
  return defaultEffortFor(candidate.harnessId, candidate.selection);
}

export interface ReviewerEffortSubstitution {
  harnessId: AgentId;
  reasoningEffort?: string;
  reasoningLabel?: string;
}

// Include every routable harness: review-time resolution may differ from the Settings display.
export function reviewerEffortSubstitutions(
  pin: ReviewerPin,
  deps: ReviewerModelDeps,
): ReviewerEffortSubstitution[] {
  const pinned = pin.reasoningEffort;
  if (pinned === undefined) return [];
  const credentials = listConfiguredCredentials(deps.credentialStore, deps.env ?? process.env);
  const routeDeps = routeDepsOf(deps);
  const out: ReviewerEffortSubstitution[] = [];
  for (const resolved of harnessesForSelection(
    { serviceId: pin.serviceId, billingMode: pin.billingMode, modelId: pin.modelId },
    credentials,
  )) {
    if (selectionHonoursEffort(resolved.harnessId, resolved.selection, pinned)) continue;
    if (!selectRouteForSelection(resolved.harnessId, resolved.selection, routeDeps).ok) continue;
    const effort = defaultEffortFor(resolved.harnessId, resolved.selection);
    const label = reasoningOptionsFor(resolved.harnessId, resolved.selection).find(
      (option) => option.value === effort,
    )?.label;
    out.push({
      harnessId: resolved.harnessId,
      ...(effort !== undefined ? { reasoningEffort: effort } : {}),
      ...(label ? { reasoningLabel: label } : {}),
    });
  }
  return out;
}

function defaultEffortFor(harnessId: AgentId, selection: ModelSelection): string | undefined {
  const options = reasoningOptionsFor(harnessId, selection);
  if (options.length === 0) return undefined;
  const authored = REVIEWER_DEFAULT_EFFORT[harnessId];
  if (authored !== null && options.some((option) => option.value === authored)) return authored;
  return options[0]?.value;
}
