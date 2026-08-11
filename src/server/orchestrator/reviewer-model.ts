/**
 * docs/261 phase 1 (reqs 1, 3, 4, 5, 8) — **who reviews the work**.
 *
 * Inviting a second model to review is only half configured today: part is a
 * ShipIt setting and the other part the agent decides for itself, because a line
 * in `CLAUDE.md` tells it to write `--agent codex`. This module is the half that
 * replaces both — the two configured reviewers, what an unconfigured one
 * resolves to, and which of the two a given implementer's work goes to.
 *
 * Nothing calls it yet. Phase 2 wires `--role reviewer` to
 * {@link selectReviewer}; phase 3 renders {@link resolveReviewerSlots}.
 *
 * Four rules live here:
 *
 *  - **A reviewer is a model, not a harness** (req 3). It names
 *    `(serviceId, billingMode, modelId)` plus a reasoning level, and the harness
 *    is derived — the same direction docs/252 set for every other selection.
 *  - **Unset is a state, not a missing value** (req 8). An unpinned slot is
 *    *auto-configured*, and the answer is computed at read time from the install
 *    as it currently stands — never written back. That is what makes adding a
 *    second service improve the reviewer with no user action, no migration and
 *    no staleness. A pin always wins.
 *  - **The reviewer used is the one FURTHEST from the implementer** (req 4), by
 *    the ordered ranking below. Family first, because the family is what carries
 *    the training a second opinion is trying not to share.
 *  - **Eligible is not runnable.** Only a reviewer with a usable *route* is
 *    ranked; one whose subscription is entirely spent falls through to the
 *    other rather than failing the review.
 *
 * ## The distance ranking (req 4)
 *
 * An ordered list of predicates, not a weighted score, so it stays explainable
 * in one line to whoever reads the Settings screen:
 *
 *  1. different family **and** different harness — the ideal
 *  2. different family
 *  3. different canonical model **and** different harness
 *  4. different canonical model
 *  5. same canonical model, different harness
 *  6. otherwise (the tie goes to the first configured reviewer)
 *
 * **Canonical model outranks harness throughout, and that ordering is the whole
 * point.** Rank "different harness" above "different model" and an implementer
 * on model M / harness H1 sends its work to *the same model M* on H2 — same
 * weights, same training, same answers, reviewing itself through a different
 * CLI — in preference to a genuinely different model N on H1. Req 4 forbids
 * reviewing work with the thing that produced it whenever any alternative is
 * configured. Tier 5 exists only for the install that has nothing else.
 *
 * **Service does not appear at all.** A gateway serves another vendor's models,
 * so two services offering one model are not distant; family and canonical model
 * say everything service was standing in for. Service still decides the
 * credential and the price.
 */

import type { AgentId, ReviewerPin, ReviewerSlot, ServiceRouting } from "../shared/types.js";
import { REVIEWER_SLOTS } from "../shared/types.js";
import type { ProviderAccountManager, ProviderRoute } from "./provider-account-manager.js";
import type { CredentialStore } from "./credential-store.js";
import {
  allServices,
  getHarness,
  getService,
  modelIdentityFor,
  sameCanonicalModel,
  sameModelFamily,
  type ConfiguredCredential,
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

/**
 * The reasoning level a reviewer ShipIt derived runs at, per harness (reqs 5, 8).
 *
 * Req 5 makes the level part of the reviewer and req 8 makes an unpinned one
 * complete, so a derived reviewer carries an effort rather than omitting the
 * flag and inheriting whatever the CLI does by default — the one thing req 5
 * rules out. `high` on both: a review is the case where thinking harder is worth
 * paying for, and it is a level both shipped harnesses declare.
 *
 * ShipIt's answer, not the harness's — which is why it lives here rather than in
 * the catalogue's harness rows. `reviewer-model.test.ts` asserts each value is
 * one that harness actually offers.
 */
export const REVIEWER_DEFAULT_EFFORT: Record<AgentId, string> = {
  claude: "high",
  codex: "high",
};

/** Where a slot's answer came from — req 8's visible state. */
export type ReviewerSource = "pinned" | "auto";

/** A rung of the ranking above; lower is further from the implementer. */
export type ReviewerTier = 1 | 2 | 3 | 4 | 5 | 6;

/**
 * Everything a review spawn needs, once a slot has been resolved and routed.
 *
 * **Deeply immutable, in the type and at runtime.** "Read time" needs a boundary
 * or the reviewer can change under a running invocation, so the resolved target
 * is what retries, attribution and the transcript card all read — recomputing
 * during a retry is how a review ends up attributed to a model that did not run
 * it. `readonly` throughout so a caller cannot reassign a field, and every
 * nested object is a frozen copy rather than a reference into the resolver's own
 * inputs (a shallow freeze left `selection` and `route` writable, which
 * cross-backend review found).
 */
export interface ReviewerTarget {
  readonly slot: ReviewerSlot;
  readonly source: ReviewerSource;
  /** Derived (req 3), never stored — and preferring a harness that is not the implementer's. */
  readonly harnessId: AgentId;
  readonly selection: Readonly<ModelSelection>;
  /** Complete (req 5): the pin's level, or this harness's ShipIt-authored default. */
  readonly reasoningEffort: string;
  /** The service's display name, for the Settings row and the consult card. */
  readonly serviceName: string;
  /** The credential this review authenticates with. Never absent — an unroutable target is not a target. */
  readonly route: Readonly<ProviderRoute>;
  /** Endpoint + credential shaping, or absent when there is nothing to shape. */
  readonly serviceRouting?: Readonly<ServiceRouting>;
  /** The secret behind `serviceRouting.credentialSourceEnv`, for a caller that builds the environment. */
  readonly credentialSecret?: string;
}

/** One slot as it currently stands — req 8's "auto-configured or pinned, and what it resolves to". */
export type ReviewerSlotResolution =
  | { slot: ReviewerSlot; source: ReviewerSource; target: ReviewerTarget; pin?: ReviewerPin }
  /** Pinned to something this install cannot run right now. */
  | { slot: ReviewerSlot; source: "pinned"; target: null; pin: ReviewerPin; reason: "pin_unavailable" }
  /** Nothing at all is runnable — no installed harness has a credentialed, routable model. */
  | { slot: ReviewerSlot; source: "auto"; target: null; reason: "nothing_eligible" };

/**
 * What the work being reviewed is running on.
 *
 * **The implementer's *resolved* selection, not the session's stored pin.** A
 * session that failed over, or was remapped by a retirement, has to be compared
 * against what it is actually running (docs/252 req 11) — comparing against the
 * row would rank a reviewer distant from a model that is not in the room.
 *
 * `selection` may be absent for a session that has never had a model picked, in
 * which case the model axes are undecidable and the ranking falls back to the
 * harness axis alone (see {@link reviewerDistanceTier}).
 */
export interface ImplementerContext {
  harnessId: AgentId;
  selection?: ModelSelection | undefined;
}

export type ReviewerSelection =
  | {
      ok: true;
      target: ReviewerTarget;
      tier: ReviewerTier;
      /**
       * What the `tier` was actually decided on.
       *
       * `harness-only` means the implementer's model could not be identified —
       * a session with no selection, or a triple naming no catalogue row — so
       * the model axes were undecidable and only the harness distinguished the
       * candidates. The ordering is unaffected (every candidate is compared
       * against the same unknown), but a `tier` of 1 must NOT be read as "a
       * different family was established" in that case. Cross-backend review
       * found the earlier shape reporting the ideal tier for a comparison
       * ShipIt had never made.
       */
      tierBasis: "model-and-harness" | "harness-only";
    }
  /**
   * No configured reviewer has a usable route. The review stops and says so —
   * the same shape as docs/252 req 9's notice, never a silent no-op.
   */
  | { ok: false; reason: "no_reviewer_available" };

export interface ReviewerModelDeps {
  credentialStore: Pick<CredentialStore, "getReviewerPin"> & ServiceRoutingCredentialSource;
  providerAccountManager?: Pick<ProviderAccountManager, "selectAccountForTurn"> | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

// ---- The ranking -----------------------------------------------------------

/**
 * How far a candidate reviewer is from the implementer, as a rung of the ordered
 * list in this module's header. Lower is further, so the best reviewer is the
 * one with the **lowest** tier.
 *
 * When either side's identity is unknown — a session with no selection, or a
 * triple naming no catalogue row — the model axes are undecidable, so
 * {@link sameCanonicalModel} and {@link sameModelFamily} both report `false` and
 * the answer collapses onto the harness axis. That fails toward *using* a
 * reviewer rather than refusing one, and the ranking never claims a sameness it
 * cannot prove.
 *
 * **The resulting tier is then a harness-axis answer wearing a model-axis
 * label**, and a caller must not read a 1 as "a different family was
 * established". Every candidate in one call is compared against the same
 * implementer, so the *ordering* is unaffected; what is affected is what the
 * number means. {@link ReviewerSelection}'s `tierBasis` is where that is said
 * out loud, because this function is given one pair and cannot say it.
 */
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

// ---- Resolution ------------------------------------------------------------

/**
 * Both slots as they currently stand, with the implementer out of the picture.
 *
 * This is the Settings view (req 8) **and** the input to {@link selectReviewer}.
 * The derivation is deliberately implementer-independent: a slot is a *setting*,
 * so it has to have one answer whether or not a session is in front of the user
 * — otherwise "what it currently resolves to" would mean something different on
 * every screen. Only the final harness bends toward the implementer, and it
 * bends at review time, in {@link selectReviewer}.
 */
export function resolveReviewerSlots(deps: ReviewerModelDeps): ReviewerSlotResolution[] {
  const credentials = listConfiguredCredentials(deps.credentialStore, deps.env ?? process.env);
  return slotPlans(credentials, deps).map((plan) =>
    resolveSlotPlan(plan, credentials, deps, undefined),
  );
}

/**
 * Pick the reviewer furthest from `implementer` (req 4), resolved and routed
 * **once**.
 *
 * The returned target is frozen and is what retries, attribution and the
 * transcript card must all use: "read time" needs a boundary or the reviewer can
 * change under a running invocation, and recomputing during a retry is how a
 * review ends up attributed to a model that did not run it. Phase 2 owns the
 * call site that captures it at spawn admission; this owns the value being
 * immutable.
 */
export function selectReviewer(
  implementer: ImplementerContext,
  deps: ReviewerModelDeps,
): ReviewerSelection {
  const credentials = listConfiguredCredentials(deps.credentialStore, deps.env ?? process.env);
  const implementerIdentity = implementer.selection
    ? modelIdentityFor(implementer.selection)
    : undefined;

  let best: { target: ReviewerTarget; tier: ReviewerTier } | undefined;
  for (const plan of slotPlans(credentials, deps)) {
    const resolved = resolveSlotPlan(plan, credentials, deps, implementer.harnessId);
    if (!resolved.target) continue;
    const tier = reviewerDistanceTier(
      { harnessId: implementer.harnessId, identity: implementerIdentity },
      {
        harnessId: resolved.target.harnessId,
        identity: modelIdentityFor(resolved.target.selection),
      },
    );
    // Strictly lower, so an equal tier keeps the EARLIER slot — which is the
    // ranking's sixth rung ("otherwise the first configured reviewer") applied
    // at every rung rather than only the last.
    if (!best || tier < best.tier) best = { target: resolved.target, tier };
  }
  if (!best) return { ok: false, reason: "no_reviewer_available" };
  return {
    ok: true,
    target: best.target,
    tier: best.tier,
    tierBasis: implementerIdentity ? "model-and-harness" : "harness-only",
  };
}

// ---- Internals -------------------------------------------------------------

/**
 * What a slot points at, before a harness or a route is chosen: the user's pin,
 * or the auto-configured derivation.
 */
interface SlotPlan {
  slot: ReviewerSlot;
  source: ReviewerSource;
  pin?: ReviewerPin;
  /** Absent only when nothing at all is runnable on this install. */
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

/**
 * Req 8's derived defaults, for whichever slots the user has not pinned.
 *
 * - **Reviewer 1** is the first model this install can actually run, in the
 *   picker's own ordering — first service, first billing mode, first model. That
 *   is `firstEligibleNonTurnSelection`'s rule (docs/252 req 9), narrowed to
 *   candidates that also have a usable **route**: an auto-configured reviewer
 *   with a spent subscription is one the review would fall through anyway, so
 *   naming it here would only make the Settings screen promise something that
 *   never runs.
 * - **Reviewer 2** is the same distance ranking run against reviewer 1 — not a
 *   filter that skips reviewer 1's family. A filter refuses to derive anything
 *   at all on a one-family install, which is precisely where req 4 says to take
 *   the best available lesser difference, and it would leave one of req 8's two
 *   reviewers unresolved on exactly the installs that need the fallback most.
 *   One ranking function derives both slots, so there is one implementation of
 *   "distant" rather than two that can disagree.
 *
 * A slot whose partner is pinned still ranks against that partner: "reviewer 2
 * is derived against reviewer 1" is about the *other* slot, whatever put a model
 * in it.
 */
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
  // No anchor means slot 1 resolved to nothing runnable, so there is nothing to
  // be distant FROM — slot 2 falls back to the same first-eligible rule.
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

/** A catalogue row this install can actually run right now, with its identity. */
interface ReviewerCandidate {
  selection: ModelSelection;
  harnessId: AgentId;
  identity: ModelIdentity | undefined;
  route: ProviderRoute;
}

/**
 * Every catalogue row this install can run, in the picker's own ordering.
 *
 * "Can run" is the conjunction req 8 states plus the route check the *Eligible
 * is not runnable* section adds: an installed harness (req 14), a credential its
 * mode holds (req 8), and a credential route that resolves today. A configured,
 * eligible subscription whose accounts are all quota-exhausted is still eligible
 * and returns `all_exhausted` — ranking it would put a reviewer first and then
 * fail, with a perfectly good second reviewer sitting unused.
 */
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

/**
 * The first harness that can BOTH run this selection and resolve a credential
 * route for it, preferring one that is not `avoidHarnessId`.
 *
 * Two steps rather than one because they answer different questions and the
 * second can fail on its own: `harnessesForSelection` says which harnesses are
 * eligible, and route selection says which of those can authenticate today.
 * Trying only the first eligible harness would drop a reviewer whose *other*
 * harness routes perfectly well.
 */
function firstRoutable(
  selection: ModelSelection,
  credentials: readonly ConfiguredCredential[],
  deps: ReviewerModelDeps,
  avoidHarnessId: AgentId | undefined,
): ReviewerCandidate | undefined {
  const routeDeps = {
    credentialStore: deps.credentialStore,
    ...(deps.providerAccountManager ? { providerAccountManager: deps.providerAccountManager } : {}),
    ...(deps.env ? { env: deps.env } : {}),
  };
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

/** Turn a slot's plan into a routed, complete target — or say why there is none. */
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
  );
  const credentialSecret = serviceRouting
    ? credentialSecretForRoute(
        deps,
        candidate.selection,
        serviceRouting.credentialSourceEnv,
        candidate.route,
      )
    : undefined;
  return Object.freeze({
    slot: plan.slot,
    source: plan.source,
    harnessId: candidate.harnessId,
    // Frozen COPIES, not the resolver's own objects: `selection` may be the
    // caller's pin or a catalogue-derived successor, and `route` comes from the
    // account walk — freezing either in place would reach outside this target,
    // and freezing neither would leave the "immutable through retries"
    // guarantee true of the wrapper only.
    selection: Object.freeze({ ...candidate.selection }),
    // Req 5 — a derived reviewer is COMPLETE. The level follows the harness that
    // was actually derived, so a slot that bent away from the implementer runs
    // at that harness's default rather than at the other one's.
    reasoningEffort: plan.pin?.reasoningEffort ?? defaultEffortFor(candidate.harnessId),
    serviceName: getService(candidate.selection.serviceId)?.name ?? candidate.selection.serviceId,
    route: Object.freeze({ ...candidate.route }),
    // `serviceRouting` is built fresh by `serviceRoutingForSelection` and is
    // reachable from nowhere else, so it is frozen in place.
    ...(serviceRouting ? { serviceRouting: Object.freeze(serviceRouting) } : {}),
    ...(credentialSecret ? { credentialSecret } : {}),
  });
}

/**
 * This harness's ShipIt-authored review level, falling back to its own first
 * declared option if {@link REVIEWER_DEFAULT_EFFORT} ever names one it dropped.
 * A reviewer with no level would violate req 5, so there is no "omit it" branch.
 */
function defaultEffortFor(harnessId: AgentId): string {
  const options = getHarness(harnessId)?.capabilities.reasoning?.options ?? [];
  const authored = REVIEWER_DEFAULT_EFFORT[harnessId];
  if (options.some((option) => option.value === authored)) return authored;
  return options[0]?.value ?? authored;
}
