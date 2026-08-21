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
 *
 * ## The harness-only tie-break (planning#408)
 *
 * When the implementer's model cannot be identified, the ranking collapses onto
 * the harness axis — and with three harnesses, BOTH derived slots can land on a
 * different-harness candidate and tie at the same rung. Keeping the earlier slot
 * there sent an unknown-model Claude session's work to claude-opus-5 on OpenCode
 * while a configured GPT reviewer sat unused. So on an equal tier, and ONLY when
 * the ranking is harness-only, {@link selectReviewer} prefers the candidate
 * whose family provably differs from the family of the implementer *harness's
 * native service* — a Claude Code session most likely runs a Claude-family
 * model, whatever its unresolved selection would have said.
 *
 * That is a **weak prior, not an identity claim**: it deliberately softens
 * "never claims a sameness it cannot prove" one notch, and three fences keep it
 * weak. It orders equal tiers only, so it can never outrank a real distance
 * difference; it never runs when the implementer's identity is known, so a real
 * comparison always wins; and it prefers only a candidate whose family is
 * *provably* different — an unidentifiable candidate, or a harness with no
 * native service (OpenCode), leaves the ordinary first-slot tie rule in charge.
 */

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

/**
 * The reasoning level a reviewer ShipIt derived runs at, per harness (reqs 5, 8).
 *
 * Req 5 makes the level part of the reviewer and req 8 makes an unpinned one
 * complete, so a derived reviewer carries an effort rather than omitting the
 * flag and inheriting whatever the CLI does by default — the one thing req 5
 * rules out. `high` throughout: a review is the case where thinking harder is
 * worth paying for, and every harness declares that level.
 *
 * ShipIt's answer, not the harness's — which is why it lives here rather than in
 * the catalogue's harness rows. `reviewer-model.test.ts` asserts each value is
 * one that harness actually offers on a real catalogue row.
 *
 * **`null` is the fourth honest answer: "this harness has no levels to choose
 * from."** No shipped harness needs it today — Grok Build did until
 * planning#435, when its subscription mode gave it selections that honour a
 * level — but the shape stays, because a harness whose CLI takes no effort flag
 * at all is a real thing to be able to declare. It is `null` rather than an
 * omitted key deliberately: the `Record<AgentId, …>` stays exhaustive, so the
 * next harness added gets a compile error here instead of silently inheriting a
 * default nobody chose.
 *
 * **This table is per HARNESS; whether a given review can use its value is per
 * SELECTION** (docs/274 req 14). `defaultEffortFor` composes the two, so a
 * harness with an authored level still contributes none to a row that discards
 * the flag.
 */
export const REVIEWER_DEFAULT_EFFORT: Record<AgentId, string | null> = {
  claude: "high",
  codex: "high",
  // `high` exists on essentially every reasoning-capable model OpenCode
  // routes (docs/268 Phase 0) and is in the harness's declared option list.
  opencode: "high",
  // `high` since planning#435, and the `null` it replaces was never "we did not
  // decide" — there had been nothing to decide, because every grok selection
  // ShipIt could run was key-billed and key mode drops the flag. The
  // subscription mode has real levels (docs/274 req 14), so there is a choice
  // again and this is it: `high` for the same reason as the other three, and it
  // is a level BOTH subscription rows offer (grok-4.5 has no `xhigh`).
  //
  // A grok reviewer landing on a key-billed row still gets no level at all —
  // `defaultEffortFor` asks the selection, not this table, so the entry being
  // non-null does not put a dead flag on a row that ignores it.
  grok: "high",
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
  /**
   * Complete (req 5): the pin's level **where this selection offers it**, and
   * otherwise the level re-derived for what this target actually resolved onto
   * (planning#352). Absent only when the selection offers no level at all
   * (docs/274) — "complete" then means the tuple names everything there is to
   * name.
   */
  readonly reasoningEffort?: string;
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
  /**
   * Both members: `subscriptionLimitsFor` is what lets the string-delivered
   * walk apply the same quota tiers the account walk does. Narrowing this to
   * `selectAccountForTurn` alone would silently drop a failover tier for a
   * supplied subscription credential.
   */
  providerAccountManager?:
    | Pick<ProviderAccountManager, "selectAccountForTurn" | "subscriptionLimitsFor">
    | undefined;
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
  // The weak prior of the header's harness-only tie-break section. Computed
  // ONLY when the implementer's identity is unknown, so a known identity can
  // never be second-guessed by a guess about the harness.
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
    // A PROVABLE difference only: an unidentifiable candidate gets no credit.
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

/**
 * Whether a candidate displaces the best reviewer seen so far (req 4 +
 * planning#408). Strictly lower tier wins; an equal tier keeps the EARLIER slot
 * — the ranking's sixth rung ("otherwise the first configured reviewer")
 * applied at every rung rather than only the last — EXCEPT that on a tie the
 * harness-only weak prior speaks first: a candidate whose family provably
 * differs from the implementer harness's native family beats slot order.
 *
 * `avoidsLikelyFamily` is false for every candidate whenever the implementer's
 * identity is known (no prior is computed at all), so the prior can never
 * override a real identity comparison; and because it decides ties only, it can
 * never outrank a real tier difference. Exported for the guard tests, which pin
 * both fences — the tier-dominance one at the unit level and also end to end,
 * via the one shipped row that CAN land a prior-avoiding candidate on the
 * implementer's own harness at a worse tier: the Z.ai coding plan's GLM, whose
 * credential is carrier-restricted to Claude Code and so cannot bend away.
 */
export function beatsIncumbentReviewer(
  candidate: { tier: ReviewerTier; avoidsLikelyFamily: boolean },
  incumbent: { tier: ReviewerTier; avoidsLikelyFamily: boolean } | undefined,
): boolean {
  if (!incumbent) return true;
  if (candidate.tier !== incumbent.tier) return candidate.tier < incumbent.tier;
  return candidate.avoidsLikelyFamily && !incumbent.avoidsLikelyFamily;
}

// ---- Internals -------------------------------------------------------------

/**
 * The one family a service offers, or `undefined` when it offers several or
 * does not exist — the harness-only tie-break's prior (planning#408).
 *
 * Read from the catalogue rather than authored per harness, so a native service
 * that ever gains a second family stops producing a prior instead of producing
 * a wrong one: a mixed-family service says nothing about what a session on its
 * harness is likely running, and `undefined` is how this says nothing.
 */
function soleFamilyOfService(serviceId: string | undefined): ModelFamily | undefined {
  const service = serviceId ? getService(serviceId) : undefined;
  if (!service) return undefined;
  const families = new Set(service.modes.flatMap((mode) => mode.models.map((m) => m.family)));
  const [only] = families;
  return families.size === 1 ? only : undefined;
}

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
    deps.credentialStore,
  );
  const credentialSecret = serviceRouting
    ? credentialSecretForRoute(
        deps,
        candidate.selection,
        serviceRouting.credentialSourceEnv,
        candidate.route,
      )
    : undefined;
  // A pinned level wins WHERE THIS SELECTION OFFERS IT; otherwise it is
  // re-derived here (planning#352). Both branches can be absent, and only for a
  // selection offering no level at all — see `defaultEffortFor`.
  const effort = effortFor(plan.pin?.reasoningEffort, candidate);
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
    // Req 5 — a derived reviewer is COMPLETE, and the level follows what was
    // ACTUALLY resolved: a slot that bent away from the implementer runs at a
    // level that harness's row offers rather than at the other one's.
    ...(effort !== undefined ? { reasoningEffort: effort } : {}),
    serviceName: getService(candidate.selection.serviceId)?.name ?? candidate.selection.serviceId,
    route: Object.freeze({ ...candidate.route }),
    // `serviceRouting` is built fresh by `serviceRoutingForSelection` and is
    // reachable from nowhere else, so it is frozen in place.
    ...(serviceRouting ? { serviceRouting: Object.freeze(serviceRouting) } : {}),
    ...(credentialSecret ? { credentialSecret } : {}),
  });
}

/**
 * **A pin applies as far as it can, and no further** (planning#352) — the level
 * a resolved reviewer runs at, given the level its slot was pinned to.
 *
 * A pin is validated at save time against the harness derived THEN
 * (`services/reviewer-settings.ts`), which is the only honest choice for a
 * *setting*: a setting cannot know which implementer it will later be ranked
 * against. But {@link selectReviewer} resolves each review on its own, so the
 * target a pinned slot lands on may be one the pinned level was never checked
 * against — and copying the level across verbatim is how a Claude-only `max`
 * reached Codex, which declares none.
 *
 * So the pin is applied **partially**: the pinned model is kept, and only the
 * level is re-derived. The two alternatives are both worse. Refusing the review
 * loses it over a level nobody chose deliberately — the user pinned a model and
 * the level came along with it. Substituting *invisibly* is the replacement req
 * 5 and phase 2's `--effort` decision both rule out, which is why the Settings
 * tab says what a pinned level becomes and where
 * ({@link reviewerEffortSubstitutions}).
 *
 * **Asked of the resolved SELECTION, not of the resolved harness's vocabulary**
 * (docs/274 req 14). Grok declares four levels that are real on a subscription
 * row and dropped before the wire on a key-billed one, so a pinned level can
 * stop applying with no harness change at all; a harness-level check would leave
 * that case broken and satisfy req 5 with a field that changes nothing.
 */
function effortFor(pinned: string | undefined, candidate: ReviewerCandidate): string | undefined {
  if (pinned !== undefined && selectionHonoursEffort(candidate.harnessId, candidate.selection, pinned)) {
    return pinned;
  }
  return defaultEffortFor(candidate.harnessId, candidate.selection);
}

/** Where a pinned level does not apply, and what a review there runs at instead. */
export interface ReviewerEffortSubstitution {
  harnessId: AgentId;
  /** Absent when that harness sends no level at all on this reviewer's row. */
  reasoningEffort?: string;
  /** That level's display label, from the same option list it was chosen from. */
  reasoningLabel?: string;
}

/**
 * Every harness this install could resolve `pin` onto whose row does **not**
 * offer the pinned level, with what a review there would run at instead —
 * planning#352's "say so" half.
 *
 * One list rather than one flag, because the Settings tab names ONE harness and
 * a review derives its own: the tab's own resolution is implementer-independent
 * (`avoidHarnessId: undefined`), while a review prefers a harness the reviewed
 * session is not on. A note about only the harness the tab happens to name would
 * stay silent about exactly the case that made this a defect — a pin accepted on
 * Claude Code and run on Codex. The tab's own harness is included when it is one
 * of them, so the same list answers both questions.
 *
 * Routable harnesses only, by the same rule the ranking uses: a harness that
 * cannot authenticate this selection is one no review can land on, so warning
 * about it would name a substitution that cannot happen.
 */
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
    // The SAME derivation `buildTarget` runs, so what the tab promises and what
    // the review does cannot drift apart.
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

/**
 * The review level for a resolved reviewer: ShipIt's authored answer for that
 * harness, falling back to the first level THIS SELECTION actually offers if
 * {@link REVIEWER_DEFAULT_EFFORT} names one the selection does not.
 *
 * `undefined` when the selection offers **no** levels, and that is not the
 * "omit it" branch req 5 rules out. Req 5 forbids leaving the level to the
 * CLI's own default when there is a level to choose; a selection with an empty
 * option set offers no choice at all, so there is nothing ShipIt could have
 * decided and nothing the CLI could have decided differently.
 *
 * **Asked of the selection rather than of the harness** (docs/274 req 14). A
 * harness's vocabulary says which words its CLI understands; whether a given
 * row's turn puts one on the wire is the `reasoningOptionsFor` composition. Grok
 * is where those differ — four levels declared, honoured only under the
 * subscription — so reading the vocabulary here would hand a key-billed review a
 * flag the CLI discards, and req 5's "COMPLETE" would be satisfied by a field
 * that changes nothing.
 */
function defaultEffortFor(harnessId: AgentId, selection: ModelSelection): string | undefined {
  const options = reasoningOptionsFor(harnessId, selection);
  if (options.length === 0) return undefined;
  const authored = REVIEWER_DEFAULT_EFFORT[harnessId];
  if (authored !== null && options.some((option) => option.value === authored)) return authored;
  return options[0]?.value;
}
