/**
 * docs/264 phase 1 (reqs 1, 2, 6, 7, 8, 9, 10, 13) — **what a role runs on**.
 *
 * A role is a named unit of agent work the user configured once. This module is
 * the half that turns a *name* into something a spawn can run: the validator
 * that decides whether a set of params is coherent, the resolver that applies a
 * caller's overrides to them, and the projection the Settings payload renders.
 *
 * The storage half is `credential-store.ts` (`getRoles` / `getRole` / `setRole`).
 * Phase 3 wired both spawn commands to it through `services/sub-agent-target.ts`,
 * which is the one parser and the one refusal rule in front of everything here
 * (req 16); {@link joinRolePrompt} is the other half a spawn needs — a role's
 * standing instructions, joined onto the run's own task (req 8).
 *
 * Four rules live here.
 *
 * **1. A role names its harness, and the harness is validated as an INPUT**
 * (reqs 6, 7). {@link validateRolePinnedParams} takes `harnessId` rather than
 * deriving one, which is the whole reason it is not `resolveReviewerPinPatch`:
 * that function derives a harness (`harnessesForSelection(patch, …)[0]`) and
 * validates the reasoning level against whichever it picked, so a level can be
 * checked against one harness and carried onto another. That is a live defect on
 * the reviewer-pin path — reachable today, since `deepseek-v4-flash` is offered
 * under both `anthropic-messages` and `openai-responses` and the two harnesses
 * declare different level sets. A role has no such gap by construction.
 *
 * **2. Saving checks COMPATIBILITY, never live availability.** Whether a
 * credential routes *right now* changes without anyone editing a role — a
 * subscription's quota resets, an account is disconnected — so requiring one at
 * save would refuse a perfectly good role during an outage. The save checks what
 * cannot change on its own (the catalogue row, the harness, the level); routing
 * is checked when the role runs, and reported by {@link resolveRoleView}. That
 * is what {@link RoleParamsPurpose} says at each call site.
 *
 * **3. Nothing is ever substituted** (req 7). No harness derivation, and no
 * retirement successor: a role pinned to a retired model reports that it is
 * `stranded` and needs a Settings edit, which is the settled divergence from how
 * a reviewer pin behaves. Being told the role cannot run beats being quietly
 * handed a different model.
 *
 * **4. An override is validated exactly as a stored tuple is**, by this same
 * validator, and an invalid one is **refused naming the parameter** rather than
 * dropped — a dropped override runs something other than what was asked for.
 * The symmetry is load-bearing: there is no combination reachable through
 * `--role X --model Y` that a role could not have been configured to hold.
 */

import type {
  AgentId,
  AgentRole,
  RoleOverrides,
  RolePinnedParams,
  RoleResolved,
  RoleUnavailableReason,
  RoleView,
  ReviewerSlot,
  ServiceRouting,
} from "../../shared/types/agent-types.js";
import { RESERVED_ROLE_NAME } from "../../shared/types/agent-types.js";
import type { ModelSelection } from "../../shared/catalogue/index.js";
import {
  getHarness,
  getModel,
  getService,
  isSelectionEligible,
  modesOfferingModel,
  reasoningOptionsFor,
  resolveStyle,
  sameSelection,
  selectionExists,
} from "../../shared/catalogue/index.js";
import { isHarnessInstalled } from "../../shared/installed-harnesses.js";
import type { CredentialStore } from "../credential-store.js";
import type { ProviderRoute } from "../provider-account-manager.js";
import {
  selectReviewer,
  type ImplementerContext,
  type ReviewerModelDeps,
  type ReviewerSource,
  type ReviewerTier,
} from "../reviewer-model.js";
import { listConfiguredCredentials, selectRouteForSelection } from "../service-routing.js";
import { ServiceError } from "./types.js";

/**
 * What role resolution reads.
 *
 * `credentialStore` widens {@link ReviewerModelDeps}'s with the role lookups,
 * because an `auto` role delegates to `selectReviewer` and therefore needs
 * everything that needs.
 */
export interface RoleDeps extends ReviewerModelDeps {
  credentialStore: ReviewerModelDeps["credentialStore"] & Pick<CredentialStore, "getRoles" | "getRole">;
  /**
   * Override "is this harness installed?", the same seam `HarnessSearchOpts`
   * offers. The default reads the deployment's install report, which answers
   * *true for everything* when there is no report — deliberately permissive, and
   * exactly what a unit test wants to narrow.
   */
  isInstalled?: ((harnessId: AgentId) => boolean) | undefined;
}

/** The validator's own dependencies — a strict subset of {@link RoleDeps}. */
export type RoleValidatorDeps = Pick<RoleDeps, "credentialStore" | "env" | "isInstalled">;

/**
 * Any subset of a role's parameters, named by a caller at the moment it starts
 * one (req 10).
 *
 * Declared in `shared/types/agent-types.ts` as of phase 3, because
 * `SpawnTarget` carries it over the wire to both spawn commands; re-exported
 * here so phase 1's callers keep one import site.
 */
export type { RoleOverrides };

/**
 * A role resolved into something a spawn can run, frozen with the role's name on
 * it.
 *
 * **Deeply immutable, in the type and at runtime**, for the reason docs/261
 * established for `ReviewerTarget`: "read time" needs a boundary or what a run
 * is attributed to can change under it.
 */
export interface ResolvedRoleTarget {
  /** The role this came from — a snapshot of the name, for attribution (req 14). */
  readonly roleName: string;
  readonly harnessId: AgentId;
  readonly selection: Readonly<ModelSelection>;
  /**
   * Absent ⇒ the role runs at `Default`: the spawn passes no reasoning flag and
   * the harness uses its own level, which is what `AgentSpawnOptions` has always
   * meant by an absent level. Includes the docs/274 req 8 case, where the named
   * harness declares no levels and Default is the only possibility.
   */
  readonly reasoningEffort?: string;
  /** The role's standing instructions (req 8), when it carries any. */
  readonly prompt?: string;
  /**
   * Whether the caller overrode anything.
   *
   * Carried because req 2's promise — a review never runs on the model that
   * produced the work — is **set aside** for an overridden run (req 10), and a
   * consumer that reports on the review needs to be able to say so. It is not a
   * gate: nothing here refuses an override to protect the guarantee.
   */
  readonly overridden: boolean;
  /**
   * The credential this run authenticates with, resolved **only** where it was
   * settled by `selectReviewer` and still applies.
   *
   * Present exactly when the answer came from the ranking and the caller did not
   * move the tuple off it: docs/261's rule is that a ranked reviewer arrives
   * already routed and the spawn must not re-ask, because re-asking answers a
   * settled question and could answer it differently. Once an override changes
   * the harness or the triple, the ranked route was resolved for something else
   * — so it is dropped rather than carried onto a tuple it was never checked
   * against, and the spawn resolves its own, exactly as the explicit path does.
   */
  readonly route?: Readonly<ProviderRoute>;
  /** Endpoint + credential shaping, present alongside {@link ResolvedRoleTarget.route}. */
  readonly serviceRouting?: Readonly<ServiceRouting>;
  /** The secret behind `serviceRouting.credentialSourceEnv`, for a caller that builds the environment. */
  readonly credentialSecret?: string;
  /** The ranking's own account of itself, for the log line. Set only when ranking ran. */
  readonly reviewer?: Readonly<{
    slot: ReviewerSlot;
    source: ReviewerSource;
    tier: ReviewerTier;
    tierBasis: "model-and-harness" | "harness-only";
  }>;
}

// ---- Validation (reqs 6, 7) ------------------------------------------------

/** Which parameter a refusal is about — the field a Settings edit has to change. */
export type RoleInvalidField =
  | "harnessId"
  | "service"
  | "billingMode"
  | "model"
  | "reasoningEffort";

/**
 * What KIND of thing is wrong, which is not the same question as which field.
 *
 * The two map onto different remedies, and conflating them sends the user to the
 * wrong place — the distinction {@link RoleUnavailableReason} exists to make:
 *
 *  - **`catalogue`** — the tuple itself no longer works: a model that has left,
 *    a harness that is gone or that could never speak to this model. Nothing but
 *    a Settings edit fixes it, and it is the role's own fault.
 *  - **`credential`** — the tuple is entirely valid and this install simply has
 *    no credential for the `(service, billing mode)` it names. The remedy is to
 *    **reconnect the service**; the role is correct and editing it would be the
 *    wrong advice.
 *
 * A **run** refuses both — it needs a credential now. A **save** refuses only the
 * first, and a **view** must not report the two alike, which is the whole reason
 * this discriminator exists rather than one boolean. See
 * {@link RoleParamsPurpose}.
 */
export type RoleCheckFailureKind = "catalogue" | "credential";

/**
 * What a params check is FOR, which is the one thing that decides whether a
 * missing credential refuses.
 *
 *  - **`"run"`** — the role is starting *now*, so a `(service, billing mode)`
 *    this install holds no credential for is a refusal: there is nothing to
 *    authenticate the run with, and saying so by name beats failing downstream.
 *  - **`"save"`** — the role is being written, and a save checks **compatibility
 *    only** (rule 2 in this module's header). A credential is an *account* fact
 *    that changes without anyone editing a role, and {@link resolveRoleView}
 *    already reports its absence as `disconnected` — "reconnect the service, the
 *    role is correct". Refusing the save contradicted that in the one place it
 *    mattered most: a disconnected role could not be edited at all, because
 *    every write revalidates the whole role, so changing only its *description*
 *    was rejected for a credential the edit did not touch and could not restore.
 *
 * The check itself is unchanged and stays in its place — **last, after every
 * catalogue check** — so a role with two faults still reports the one an edit
 * fixes rather than sending the user to reconnect a service that would not have
 * helped. `"save"` skips that final step; it never reorders it.
 */
export type RoleParamsPurpose = "run" | "save";

export type RoleParamsCheck =
  | { ok: true; params: RolePinnedParams }
  | { ok: false; kind: RoleCheckFailureKind; field: RoleInvalidField; message: string };

/**
 * Is this tuple one a role could run? The harness-explicit check, as a **result**
 * rather than a throw.
 *
 * Two callers need opposite things from the same rules — a save and an override
 * want an error naming the parameter, and the Settings list wants to render an
 * unresolved role *with* the offending field marked — so the rules live here once
 * and {@link validateRolePinnedParams} throws on top.
 *
 * The order of the checks is the order the answers depend on each other in: a
 * harness that is not installed makes "can it carry this model" unanswerable, a
 * service that is gone makes the mode meaningless, and a model that is not in
 * the catalogue makes eligibility meaningless.
 *
 * **The catalogue question and the credential question are deliberately
 * separate**, and separating them is what makes `disconnected` a real state
 * rather than a label. "Can this harness speak to this model at all" is a
 * catalogue fact that only an edit can change; "does this install hold a
 * credential for that `(service, mode)`" is an account fact that reconnecting
 * fixes. Asking them as one question (`isSelectionEligible` alone) answers both
 * with "stranded", which tells the user to edit a role that is perfectly
 * correct.
 *
 * **Every catalogue check runs before the credential one**, so a role with two
 * faults reports the one an edit fixes. See the comment at the credential step.
 *
 * `purpose` decides whether the credential step runs at all — see
 * {@link RoleParamsPurpose}. It defaults to `"run"`, the stricter answer, so a
 * caller that has not thought about it gets the safe one.
 */
export function checkRolePinnedParams(
  params: RolePinnedParams,
  deps: RoleValidatorDeps,
  purpose: RoleParamsPurpose = "run",
): RoleParamsCheck {
  const { harnessId } = params;
  const selection: ModelSelection = {
    serviceId: params.serviceId,
    billingMode: params.billingMode,
    modelId: params.modelId,
  };
  const harness = getHarness(harnessId);
  if (!harness) {
    return {
      ok: false,
      kind: "catalogue",
      field: "harnessId",
      message: `No harness named "${harnessId}".`,
    };
  }
  const installed = deps.isInstalled ?? isHarnessInstalled;
  if (!installed(harnessId)) {
    return {
      ok: false,
      kind: "catalogue",
      field: "harnessId",
      message: `${harness.name} is not installed on this deployment.`,
    };
  }
  // Each of the three located separately, so the refusal names the parameter the
  // editor has to highlight (rule (d)) rather than blaming the model for a
  // service that has left the catalogue.
  const service = getService(params.serviceId);
  if (!service) {
    return {
      ok: false,
      kind: "catalogue",
      field: "service",
      message: `No service named "${params.serviceId}".`,
    };
  }
  if (!service.modes.some((mode) => mode.kind === params.billingMode)) {
    return {
      ok: false,
      kind: "catalogue",
      field: "billingMode",
      message: `${service.name} has no "${params.billingMode}" billing mode.`,
    };
  }
  // No retirement successor, deliberately (req 7): a role is never re-pointed at
  // a different model, so a retired one reads as stranded rather than resolving
  // through the successor a reviewer pin would follow.
  if (!selectionExists(selection)) {
    return {
      ok: false,
      kind: "catalogue",
      field: "model",
      message:
        `No model "${params.modelId}" is offered by ${params.serviceId} on the `
        + `"${params.billingMode}" billing mode.`,
    };
  }
  // Non-null: `selectionExists` above proved the row is in the catalogue.
  const model = getModel(selection)!;
  const label = model.label;
  // The catalogue half: could this harness EVER speak to this model? A style in
  // common is the whole question, and no credential can change the answer.
  if (resolveStyle(harnessId, model) === undefined) {
    return {
      ok: false,
      kind: "catalogue",
      field: "harnessId",
      message: `${harness.name} cannot speak to ${label} — they share no API style.`,
    };
  }
  // Against the level set of the harness the role NAMES. This is the one step
  // that differs from `resolveReviewerPinPatch`, and it differs in the direction
  // that matters — see this module's header.
  //
  // **An absent level is `Default`, and Default is always valid** (docs/264
  // req 1's 2026-08-18 resolved question) — every harness has a level it runs at
  // when passed no flag, so there is nothing to check it against and nothing
  // that can retire out from under it.
  //
  // **That subsumes docs/274 req 8 rather than replacing it.** That rule reached
  // the same optionality from the other end: a harness declaring NO levels takes
  // a role with no level, because it is complete with one field fewer. Such a
  // role is at Default — the only thing it can be. The difference is only that
  // absent is now legal on every harness, not just that one, so the empty set no
  // longer needs a branch of its own.
  //
  // Naming a level on a harness that declares none stays a refusal, exactly as
  // docs/274 left it: the claim is false about the harness. It now carries the
  // remedy, which is the thing the user actually has to do.
  if (params.reasoningEffort !== undefined) {
    // What this SELECTION offers on this harness, not the harness's raw
    // vocabulary (docs/274 req 14). Since planning#435 the two diverge: grok
    // declares four levels and honours none of them on a key-billed row, so
    // validating against the vocabulary would accept a role whose level the CLI
    // drops before the wire — a pinned parameter that silently does nothing.
    const options = reasoningOptionsFor(harnessId, selection);
    if (options.length === 0) {
      return {
        ok: false,
        kind: "catalogue",
        field: "reasoningEffort",
        message:
          `${harness.name} offers no reasoning levels on ${label}, so a role on it cannot name one. `
          + "Use the Default level.",
      };
    }
    if (!options.some((option) => option.value === params.reasoningEffort)) {
      return {
        ok: false,
        kind: "catalogue",
        field: "reasoningEffort",
        message:
          `"${params.reasoningEffort}" is not a reasoning level ${harness.name} offers on ${label}. `
          + `Valid levels: ${options.map((o) => o.value).join(", ")}, or Default.`,
      };
    }
  }
  // **The credential check goes LAST, after every catalogue check has passed.**
  // Ordering is load-bearing here rather than incidental: `credential` reports
  // "the role is fine, reconnect the service", so it may only be returned once
  // the tuple is known to be entirely valid. Asking it earlier meant a role that
  // had lost its credential *and* carried a level its harness no longer declares
  // reported `disconnected` — sending the user to reconnect a service that would
  // not have fixed it, while the edit it actually needed went unmentioned.
  // Cross-agent review found that; every tuple fault now outranks it.
  //
  // **A save skips it entirely** (rule 2, {@link RoleParamsPurpose}), which is
  // the only thing `purpose` changes: the ordering above is untouched, so a role
  // with two faults still reports the editable one on every path.
  if (purpose === "save") return { ok: true, params: normalize(params) };
  const credentials = listConfiguredCredentials(deps.credentialStore, deps.env ?? process.env);
  if (!isSelectionEligible(harnessId, selection, credentials)) {
    return {
      ok: false,
      kind: "credential",
      field: "service",
      message:
        `${service.name} has no credential ${harness.name} can use for `
        + `${params.serviceId}/${params.billingMode}.`,
    };
  }
  return { ok: true, params: normalize(params) };
}

/**
 * The checked tuple, rebuilt field by field so nothing a caller passed rides
 * along.
 *
 * The level is spread conditionally rather than copied: `Default` is stored as
 * the **absence** of the key, so writing `reasoningEffort: undefined` would put
 * an explicit `undefined` into the JSON the credential store serializes.
 */
function normalize(params: RolePinnedParams): RolePinnedParams {
  return {
    kind: "pinned",
    harnessId: params.harnessId,
    serviceId: params.serviceId,
    billingMode: params.billingMode,
    modelId: params.modelId,
    ...(params.reasoningEffort !== undefined ? { reasoningEffort: params.reasoningEffort } : {}),
  };
}

/**
 * {@link checkRolePinnedParams} as a refusal — the form a save and an override
 * both want.
 *
 * `what` prefixes the message so one rule can report two situations honestly:
 * a stored role that no longer works and an override that never would are the
 * same defect and a different remedy.
 *
 * `purpose` is the save/run distinction {@link RoleParamsPurpose} states, and it
 * is the whole of what a save does differently.
 */
export function validateRolePinnedParams(
  params: RolePinnedParams,
  deps: RoleValidatorDeps,
  what = "This role",
  purpose: RoleParamsPurpose = "run",
): RolePinnedParams {
  const checked = checkRolePinnedParams(params, deps, purpose);
  if (!checked.ok) throw new ServiceError(400, `${what} cannot run: ${checked.message}`);
  return checked.params;
}

// ---- Resolution (reqs 7, 10, 13) -------------------------------------------

/**
 * Turn a role name plus whatever the caller overrode into a frozen target
 * (reqs 10, 13).
 *
 * Three paths, and the branch is on the params kind and on how much was
 * overridden:
 *
 *  - **`pinned`** — the role's tuple with any override substituted over it, and
 *    nothing else moved: the harness is the role's unless overridden, and so are
 *    the service and the billing mode when only the model is overridden. A model
 *    the role's service does not offer is **refused naming the parameter**
 *    rather than relocated — see {@link applyOverrides}.
 *  - **`auto` with no override** — docs/261's ranking, unchanged, distance
 *    guarantee and all. The one path that carries a route.
 *  - **`auto` with a COMPLETE override** — resolved directly, and
 *    `selectReviewer` is **not called at all**. Ranking first would let a failed
 *    ranking reject a target the caller fully specified, which reqs 10 and 16
 *    both forbid: "any subset" includes the whole set.
 *  - **`auto` with a PARTIAL override** — completed from the ranked winner,
 *    which is the only thing that can supply the rest; a level-only or
 *    harness-only override identifies no target by itself. If the ranking fails
 *    here the call fails with the ranking's own reason, because there is
 *    genuinely nothing to complete from and inventing one is the substitution
 *    req 7 forbids.
 *
 * **The distance guarantee is off for any overridden run** (req 10) and nothing
 * here tries to preserve it: an overridden reviewer may land on the
 * implementer's own model, which is the requirement rather than a bug. The
 * caller said what they wanted and it stays visible in the request that made it.
 *
 * `implementer` is the caller's to capture — docs/261 takes it from the resident
 * process's spawn stamp rather than the mutable session row — and is read only
 * where ranking runs.
 */
export function resolveRoleByName(
  name: string,
  overrides: RoleOverrides,
  implementer: ImplementerContext,
  deps: RoleDeps,
): ResolvedRoleTarget {
  const role = deps.credentialStore.getRole(name);
  if (!role) throw unknownRole(name, deps);
  const overridden = hasOverride(overrides);

  if (role.params.kind === "pinned") {
    const params = validateRolePinnedParams(
      applyOverrides(role.params, overrides, deps, "role"),
      deps,
      overridden ? `The role "${name}" with those overrides` : `The role "${name}"`,
    );
    return freezeTarget(role, params, overridden, undefined);
  }

  // (a) A complete override needs no base, so the ranking is not consulted.
  const complete = completeOverride(overrides);
  if (complete) {
    const params = validateRolePinnedParams(
      complete,
      deps,
      `The role "${name}" with those overrides`,
    );
    return freezeTarget(role, params, true, undefined);
  }

  const chosen = selectReviewer(implementer, deps);
  if (!chosen.ok) {
    // (b)'s other half: the ranking's own reason, not a fabricated base.
    throw new ServiceError(
      400,
      `The role "${name}" cannot run: neither configured reviewer has a credential that can run `
        + "right now. Connect a service in Settings, or wait for the quota to reset.",
    );
  }
  const base: RolePinnedParams = {
    kind: "pinned",
    harnessId: chosen.target.harnessId,
    serviceId: chosen.target.selection.serviceId,
    billingMode: chosen.target.selection.billingMode,
    modelId: chosen.target.selection.modelId,
    reasoningEffort: chosen.target.reasoningEffort,
  };
  if (!overridden) {
    // Nothing overridden — the ranked target verbatim, route and all, exactly as
    // docs/261 resolves it today. **Deliberately NOT re-validated here**, and
    // the reason is worth stating precisely rather than as "it validates
    // itself", which is not true.
    //
    // `selectReviewer` does guarantee an installed harness, an eligible model
    // and a usable route. It does NOT guarantee the level: a user-pinned slot's
    // `reasoningEffort` is validated against the *settings-time derived* harness
    // and then copied onto whichever harness the ranking lands on
    // (`reviewer-model.ts`'s `buildTarget`), which can differ. That is a live
    // defect on the reviewer-pin path — reachable since `deepseek-v4-flash`
    // became dual-harness — and it is tracked as planning#381.
    //
    // Running the role validator here would *mask* it by refusing the review
    // instead, which is a behaviour change to the un-overridden reviewer that
    // phase 1 is expressly not making: docs/261's ranking survives intact behind
    // this branch. The fix belongs with planning#381, which owns the choice
    // between refusing and substituting.
    return freezeTarget(role, base, false, chosen);
  }
  const params = validateRolePinnedParams(
    applyOverrides(base, overrides, deps, "ranked"),
    deps,
    `The role "${name}" with those overrides`,
  );
  return freezeTarget(role, params, true, chosen);
}

/**
 * Req 13 — an unknown name is refused, and the refusal names the roles that do
 * exist. The list is the whole remedy; nothing else needs saying.
 */
function unknownRole(name: string, deps: RoleDeps): ServiceError {
  const known = deps.credentialStore
    .getRoles()
    .map((role) => role.name)
    .join(", ");
  return new ServiceError(400, `Unknown role "${name}". Roles on this install: ${known}.`);
}

function hasOverride(overrides: RoleOverrides): boolean {
  return (
    overrides.harnessId !== undefined
    || overrides.serviceId !== undefined
    || overrides.billingMode !== undefined
    || overrides.modelId !== undefined
    || overrides.reasoningEffort !== undefined
  );
}

/** The five together, or `undefined` — the shape that needs no base at all. */
function completeOverride(overrides: RoleOverrides): RolePinnedParams | undefined {
  const { harnessId, serviceId, billingMode, modelId, reasoningEffort } = overrides;
  if (!harnessId || !serviceId || !billingMode || !modelId || !reasoningEffort) return undefined;
  return { kind: "pinned", harnessId, serviceId, billingMode, modelId, reasoningEffort };
}

/**
 * Whose decision the base tuple is, which is the one thing an override has to
 * treat differently.
 *
 *  - **`role`** — the five choices the user made and can see in Settings.
 *  - **`ranked`** — ShipIt's own working state for a ranking it just performed:
 *    the winner `selectReviewer` returned for an `auto` role, whose
 *    `(service, billing mode, model)` may come from a **reviewer slot pin**.
 *
 * They are not the same object wearing two labels. A slot pin is a note ShipIt
 * keeps about how to rank; a pinned role is five parameters the user chose.
 */
type OverrideBaseKind = "role" | "ranked";

/**
 * Substitute a caller's overrides over a base tuple.
 *
 * **What the model override does depends on whose tuple it lands on**, and that
 * is the whole subtlety here.
 *
 * **`ranked` — a pin is a `(service, billing mode, model)` triple, not three
 * independent fields** (plan rule (c), the `auto`/reviewer branch). Overriding
 * the **model** replaces the triple as a whole and re-resolves where that model
 * lives — not because pins may be discarded, but because a slot pinned *for
 * model M* says nothing about model X, so there is no surviving decision to
 * honour. The caller's own `--service` / `--billing-mode` still win where it
 * named them: re-resolution fills only the half of the location it left unsaid.
 *
 * **`role` — "everything not overridden" is literal (req 10), and an override
 * that makes the tuple incoherent is refused rather than repaired.** Overriding
 * the model does not entitle ShipIt to move the service or the billing mode to
 * wherever that model happens to live: those came from the role, the caller did
 * not name them, and changing them would be a substitution invisible in the
 * request, which req 7 forbids. Where the role's service does not offer the
 * overridden model the call is **refused naming the parameter**, and the caller
 * names `--service` too.
 *
 * The accepted cost: `--model X` alone now fails whenever the role's service
 * does not offer X. Req 12's inventory is what makes that discoverable rather
 * than a guessing game.
 *
 * Overriding the **level** or the **harness** leaves the triple untouched on
 * either base.
 */
function applyOverrides(
  base: RolePinnedParams,
  overrides: RoleOverrides,
  deps: RoleValidatorDeps,
  baseKind: OverrideBaseKind,
): RolePinnedParams {
  const harnessId = overrides.harnessId ?? base.harnessId;
  // Spread rather than assigned, so a Default role stays Default by the same
  // encoding every other producer of `RolePinnedParams` uses — the ABSENCE of
  // the key. Writing `reasoningEffort: undefined` here happened to work only
  // because `normalize` strips it downstream; cross-agent review flagged the
  // dependence on that as the untidy invariant it is. There is no "override
  // back to Default" sentinel, and none is needed: naming no `--effort` already
  // means "leave the level as the role has it".
  const reasoningEffort = overrides.reasoningEffort ?? base.reasoningEffort;
  const withEffort = reasoningEffort !== undefined ? { reasoningEffort } : {};
  if (baseKind === "ranked" && overrides.modelId !== undefined) {
    const located = locateModel(overrides.modelId, overrides, harnessId, deps);
    if (!located) {
      throw new ServiceError(
        400,
        `No model "${overrides.modelId}" is offered by any service`
          + `${overrides.serviceId ? ` on ${overrides.serviceId}` : ""}.`,
      );
    }
    return { kind: "pinned", harnessId, ...located, ...withEffort };
  }
  const substituted: RolePinnedParams = {
    kind: "pinned",
    harnessId,
    serviceId: overrides.serviceId ?? base.serviceId,
    billingMode: overrides.billingMode ?? base.billingMode,
    modelId: overrides.modelId ?? base.modelId,
    ...withEffort,
  };
  if (baseKind === "role" && overrides.modelId !== undefined) {
    refuseModelAwayFromRolesService(substituted, overrides);
  }
  return substituted;
}

/**
 * The refusal that stands where the relocation used to (reqs 7, 10).
 *
 * The validator refuses this tuple too — `No model "X" is offered by <service>
 * on the "<mode>" billing mode` — but it cannot carry the remedy, and that is
 * why this refusal exists rather than falling through to it. The same validator
 * message is what a **save** from the role editor reports, where "name
 * `--service`" is advice about a flag that is not there. So the override-time
 * refusal is stated here, beside the substitution it replaces, and names the
 * parameter the caller still has to say.
 *
 * **It asks for the SMALLEST set of flags that actually reaches the model**, not
 * for both halves of the location every time. `claude-opus-5` is offered on
 * `anthropic/sub` and `anthropic/key`, so a role pinned to `deepseek/key` needs
 * `--service anthropic` and nothing else — telling that caller to name
 * `--billing-mode` too would be advice to restate a value that is already right.
 *
 * Where nothing the caller can still name would reach the model, this falls
 * through to the validator, whose message is then the true one. That covers both
 * the caller who named the whole location already and the model no service
 * offers at all — pointing either at `--service` would be false.
 */
function refuseModelAwayFromRolesService(
  params: RolePinnedParams,
  overrides: RoleOverrides,
): void {
  const selection: ModelSelection = {
    serviceId: params.serviceId,
    billingMode: params.billingMode,
    modelId: params.modelId,
  };
  if (selectionExists(selection)) return;
  const elsewhere = modesOfferingModel(params.modelId);
  if (elsewhere.length === 0) return;
  const freeService = overrides.serviceId === undefined;
  const freeMode = overrides.billingMode === undefined;
  // Each option is "the flags the caller would have to add", cheapest first.
  const options: { flags: string[]; reaches: boolean }[] = [
    {
      flags: ["--service"],
      reaches: freeService && elsewhere.some((c) => c.billingMode === params.billingMode),
    },
    {
      flags: ["--billing-mode"],
      reaches: freeMode && elsewhere.some((c) => c.serviceId === params.serviceId),
    },
    { flags: ["--service", "--billing-mode"], reaches: freeService && freeMode },
  ];
  const remedy = options.find((option) => option.reaches);
  if (!remedy) return;
  const service = getService(params.serviceId);
  const offered = [...new Set(elsewhere.map((c) => `${c.serviceId}/${c.billingMode}`))].join(", ");
  throw new ServiceError(
    400,
    // Says "a service or billing mode you did not name" rather than "the role's
    // service", because the caller may well have named one of the two: a role on
    // DeepSeek invoked with `--service zai --model glm-5.2[1m]` is refused for
    // the *billing mode*, which came from the role, on a service the caller
    // moved itself. Naming the wrong half in the explanation would send the
    // reader looking at a parameter they had already set correctly.
    `${service?.name ?? params.serviceId} does not offer "${params.modelId}" on the `
      + `"${params.billingMode}" billing mode. Overriding the model does not move a service or `
      + `billing mode you did not name — that came from the role. Name `
      + `${remedy.flags.join(" and ")} as well; "${params.modelId}" is offered on ${offered}.`,
  );
}

/**
 * Where an overridden model lives, honouring whichever half of the location the
 * caller named.
 *
 * Prefers a `(service, mode)` this harness can actually carry with the
 * credentials configured, and falls back to the first that offers the model at
 * all. The fallback matters: returning `undefined` there would refuse with "no
 * service offers this model", which is false and points at the wrong parameter.
 * Handing the tuple to the validator instead produces the true refusal —
 * `${harness} cannot run ${model}` — naming the parameter that is actually
 * wrong (rule (d)).
 */
function locateModel(
  modelId: string,
  overrides: RoleOverrides,
  harnessId: AgentId,
  deps: RoleValidatorDeps,
): ModelSelection | undefined {
  const candidates = modesOfferingModel(modelId).filter(
    (c) =>
      (overrides.serviceId === undefined || c.serviceId === overrides.serviceId)
      && (overrides.billingMode === undefined || c.billingMode === overrides.billingMode),
  );
  if (candidates.length === 0) return undefined;
  const credentials = listConfiguredCredentials(deps.credentialStore, deps.env ?? process.env);
  const carried = candidates.find((c) =>
    isSelectionEligible(harnessId, { ...c, modelId }, credentials),
  );
  const chosen = carried ?? candidates[0];
  return { serviceId: chosen.serviceId, billingMode: chosen.billingMode, modelId };
}

function freezeTarget(
  role: AgentRole,
  params: RolePinnedParams,
  overridden: boolean,
  chosen: Extract<ReturnType<typeof selectReviewer>, { ok: true }> | undefined,
): ResolvedRoleTarget {
  const selection: ModelSelection = {
    serviceId: params.serviceId,
    billingMode: params.billingMode,
    modelId: params.modelId,
  };
  // The ranked route survives only where the tuple it was resolved for did.
  const routeStillApplies =
    chosen?.target.harnessId === params.harnessId
    && sameSelection(chosen?.target.selection, selection);
  return Object.freeze({
    roleName: role.name,
    harnessId: params.harnessId,
    selection: Object.freeze(selection),
    ...(params.reasoningEffort !== undefined ? { reasoningEffort: params.reasoningEffort } : {}),
    ...(role.prompt ? { prompt: role.prompt } : {}),
    overridden,
    ...(routeStillApplies && chosen
      ? {
          route: Object.freeze({ ...chosen.target.route }),
          ...(chosen.target.serviceRouting
            ? { serviceRouting: Object.freeze({ ...chosen.target.serviceRouting }) }
            : {}),
          ...(chosen.target.credentialSecret
            ? { credentialSecret: chosen.target.credentialSecret }
            : {}),
        }
      : {}),
    ...(chosen
      ? {
          reviewer: Object.freeze({
            slot: chosen.target.slot,
            source: chosen.target.source,
            tier: chosen.tier,
            tierBasis: chosen.tierBasis,
          }),
        }
      : {}),
  });
}

// ---- The prompt join (req 8) -----------------------------------------------

/**
 * The destination limits a joined prompt is checked against, named where they
 * are enforced rather than restated at each call site.
 *
 * They differ because the two destinations differ: a one-shot consult is handed
 * a diff and a task in one channel, a child session gets an opening instruction
 * it will build on for days. Both numbers are the ones already shipped
 * (`shipit-agent.ts`, `child-sessions.ts`); nothing here changes them.
 */
export const ROLE_PROMPT_LIMITS = { oneShot: 200_000, child: 50_000 } as const;

/**
 * docs/264-agent-roles req 8 — join a role's **standing instructions** onto the task a run
 * was given.
 *
 * A sub-agent has ONE prompt channel (docs/144), so the two have to become one
 * string, and three things about that join are load-bearing:
 *
 *  - **Framing.** The halves are labelled, so the callee can tell a standing
 *    brief ("what this job is") from the thing it was asked to do now. Unlabelled
 *    concatenation reads as one instruction and invites the callee to treat the
 *    task as a continuation of the brief.
 *  - **Identity when there is nothing to add.** A role with no standing
 *    instructions returns the task **unchanged** — no header, no separator, not
 *    one byte. That is a promise about *this function*, not end to end: child
 *    creation trims the prompt it is handed (`child-sessions.ts`), so claiming
 *    byte-identity all the way to the callee would be false.
 *  - **Length.** The stored prompt is bounded at save (`credential-store.ts`),
 *    but a bounded prompt plus a valid task can still exceed the destination's
 *    limit — so the *combined* string is checked here, and the failure **names
 *    the role**. Blaming the task would send the caller to shorten the one half
 *    it did not choose.
 */
export function joinRolePrompt(
  task: string,
  target: { roleName?: string | undefined; rolePrompt?: string | undefined },
  limit: number,
): string {
  const standing = target.rolePrompt?.trim();
  const joined = standing
    ? `## Standing instructions for the "${target.roleName}" role\n\n${standing}\n\n## Your task\n\n${task}`
    : task;
  if (joined.length > limit) {
    throw new ServiceError(
      400,
      standing
        ? `The "${target.roleName}" role's standing instructions plus this task exceed `
          + `${limit.toLocaleString()} characters (${joined.length.toLocaleString()}). `
          + "Shorten the task, or the role's standing instructions in Settings."
        : `The prompt exceeds ${limit.toLocaleString()} characters.`,
    );
  }
  return joined;
}

// ---- The settings payload --------------------------------------------------

/**
 * Every role, with its resolution — what the settings payload carries.
 *
 * **The server sends the resolution**, the same rule docs/261 set for a reviewer
 * slot: which harness runs a model and which levels it declares are catalogue
 * rules, and a second implementation in the browser is how the Settings screen
 * starts promising something other than what runs.
 */
export function buildRoleSettings(deps: RoleDeps): RoleView[] {
  return deps.credentialStore.getRoles().map((role) => resolveRoleView(role, deps));
}

/**
 * One role as the Settings list sees it — resolved, or unresolved with the
 * reason and the field at fault.
 *
 * **Three failure states, not two** ({@link RoleUnavailableReason}), because the
 * remedy differs in each: `stranded` needs a Settings edit, `disconnected` needs
 * the *service* reconnected and the role left alone, and `quota_exhausted` needs
 * nothing at all. Only the first is the role's fault, and telling a user to edit
 * a perfectly good role because a subscription is spent would be wrong.
 */
export function resolveRoleView(role: AgentRole, deps: RoleDeps): RoleView {
  const base = {
    name: role.name,
    ...(role.description ? { description: role.description } : {}),
    ...(role.prompt ? { prompt: role.prompt } : {}),
    params: role.params,
    reserved: role.name === RESERVED_ROLE_NAME,
  };
  // The reviewer's params are docs/261's two ranked slots, which ride the same
  // payload as `reviewers`. A single `resolved` here would have to pick one of
  // the two and misreport whichever it dropped.
  if (role.params.kind === "auto") return base;

  const checked = checkRolePinnedParams(role.params, deps);
  if (!checked.ok) {
    // A credential-level failure is the SERVICE's problem, not the role's. The
    // tuple is intact, so it carries no `invalidField`: there is no field to
    // highlight and no edit to make, and marking one would send the user to
    // change a role that is entirely correct.
    if (checked.kind === "credential") return { ...base, unavailableReason: "disconnected" };
    return { ...base, unavailableReason: "stranded", invalidField: checked.field };
  }
  const selection: ModelSelection = {
    serviceId: role.params.serviceId,
    billingMode: role.params.billingMode,
    modelId: role.params.modelId,
  };
  const account = selectRouteForSelection(role.params.harnessId, selection, {
    credentialStore: deps.credentialStore,
    ...(deps.providerAccountManager ? { providerAccountManager: deps.providerAccountManager } : {}),
    ...(deps.env ? { env: deps.env } : {}),
  });
  if (!account.ok) {
    const reason: RoleUnavailableReason =
      account.reason === "all_exhausted" ? "quota_exhausted" : "disconnected";
    return {
      ...base,
      unavailableReason: reason,
      ...(account.reason === "all_exhausted" ? { earliestResetAt: account.earliestResetAt } : {}),
    };
  }
  return { ...base, resolved: describe(role.params) };
}

function describe(params: RolePinnedParams): RoleResolved {
  const selection: ModelSelection = {
    serviceId: params.serviceId,
    billingMode: params.billingMode,
    modelId: params.modelId,
  };
  const harness = getHarness(params.harnessId);
  // Both absent for a role at Default — the client renders "Default" from the
  // absence, exactly as the composer's picker does. Naming the level here would
  // mean resolving the harness's own default, which ShipIt does not know and
  // must not guess (req 7).
  const reasoningLabel =
    params.reasoningEffort === undefined
      ? undefined
      : harness?.capabilities.reasoning?.options.find(
          (option) => option.value === params.reasoningEffort,
        )?.label;
  return {
    harnessId: params.harnessId,
    harnessName: harness?.name ?? params.harnessId,
    serviceId: params.serviceId,
    billingMode: params.billingMode,
    serviceName: getService(params.serviceId)?.name ?? params.serviceId,
    modelId: params.modelId,
    label: getModel(selection)?.label ?? params.modelId,
    ...(params.reasoningEffort !== undefined
      ? { reasoningEffort: params.reasoningEffort }
      : {}),
    ...(reasoningLabel ? { reasoningLabel } : {}),
  };
}
