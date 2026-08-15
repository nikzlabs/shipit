/**
 * docs/264 phase 1 (reqs 1, 2, 6, 7, 8, 9, 10, 13) — **what a role runs on**.
 *
 * A role is a named unit of agent work the user configured once. This module is
 * the half that turns a *name* into something a spawn can run: the validator
 * that decides whether a set of params is coherent, the resolver that applies a
 * caller's overrides to them, and the projection the Settings payload renders.
 *
 * The storage half is `credential-store.ts` (`getRoles` / `getRole` / `setRole`).
 * The two spawn commands are phase 3's, and nothing here is wired to them yet.
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
 * subscription's quota resets — so requiring a live route at save would refuse a
 * perfectly good role during an outage. The save checks what cannot change on
 * its own (the catalogue row, the harness, the level); routing is checked when
 * the role runs, and reported by {@link resolveRoleView}.
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
  RolePinnedParams,
  RoleResolved,
  RoleUnavailableReason,
  RoleView,
  ReviewerSlot,
  ServiceRouting,
} from "../../shared/types/agent-types.js";
import { RESERVED_ROLE_NAME } from "../../shared/types/agent-types.js";
import type { BillingMode, ModelSelection } from "../../shared/catalogue/index.js";
import {
  getHarness,
  getModel,
  getService,
  isSelectionEligible,
  modesOfferingModel,
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
 * Every field optional, and that is req 16's "partial is the normal case":
 * a caller names what it cares about and the role supplies the rest. The empty
 * object is the ordinary path — a bare role name, nothing overridden.
 */
export interface RoleOverrides {
  harnessId?: AgentId | undefined;
  serviceId?: string | undefined;
  billingMode?: BillingMode | undefined;
  modelId?: string | undefined;
  reasoningEffort?: string | undefined;
}

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
  readonly reasoningEffort: string;
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
 * A **save** refuses both (the plan's validator checks "installed, able to carry
 * the model *and* credentialed"). A **view** must not report them alike, which
 * is the whole reason this discriminator exists rather than one boolean.
 */
export type RoleCheckFailureKind = "catalogue" | "credential";

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
 */
export function checkRolePinnedParams(
  params: RolePinnedParams,
  deps: RoleValidatorDeps,
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
  const options = harness.capabilities.reasoning?.options ?? [];
  if (options.length === 0) {
    return {
      ok: false,
      kind: "catalogue",
      field: "reasoningEffort",
      message: `${harness.name} declares no reasoning levels, so a role on it cannot name one.`,
    };
  }
  if (!options.some((option) => option.value === params.reasoningEffort)) {
    return {
      ok: false,
      kind: "catalogue",
      field: "reasoningEffort",
      message:
        `"${params.reasoningEffort}" is not a reasoning level ${harness.name} offers. `
        + `Valid levels: ${options.map((o) => o.value).join(", ")}.`,
    };
  }
  // **The credential check goes LAST, after every catalogue check has passed.**
  // Ordering is load-bearing here rather than incidental: `credential` reports
  // "the role is fine, reconnect the service", so it may only be returned once
  // the tuple is known to be entirely valid. Asking it earlier meant a role that
  // had lost its credential *and* carried a level its harness no longer declares
  // reported `disconnected` — sending the user to reconnect a service that would
  // not have fixed it, while the edit it actually needed went unmentioned.
  // Cross-agent review found that; every tuple fault now outranks it.
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
  return {
    ok: true,
    params: {
      kind: "pinned",
      harnessId,
      serviceId: params.serviceId,
      billingMode: params.billingMode,
      modelId: params.modelId,
      reasoningEffort: params.reasoningEffort,
    },
  };
}

/**
 * {@link checkRolePinnedParams} as a refusal — the form a save and an override
 * both want.
 *
 * `what` prefixes the message so one rule can report two situations honestly:
 * a stored role that no longer works and an override that never would are the
 * same defect and a different remedy.
 */
export function validateRolePinnedParams(
  params: RolePinnedParams,
  deps: RoleValidatorDeps,
  what = "This role",
): RolePinnedParams {
  const checked = checkRolePinnedParams(params, deps);
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
 *  - **`pinned`** — the role's tuple with any override substituted over it. The
 *    harness is the role's unless overridden; nothing is derived.
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
      applyOverrides(role.params, overrides, deps),
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
    applyOverrides(base, overrides, deps),
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
 * Substitute a caller's overrides over a base tuple.
 *
 * **A pin is a `(service, billing mode, model)` triple, not three independent
 * fields**, which is the one subtlety here. Overriding the **model** replaces
 * the triple as a whole and re-resolves where that model lives — not because
 * pins may be discarded, but because a service pinned *for model M* says nothing
 * about model X, so there is no surviving decision to honour. Overriding the
 * **level** or the **harness** leaves the triple untouched. Nothing the user
 * chose that still applies is ever dropped.
 *
 * The caller's own `--service` / `--billing-mode` still win where it named them:
 * re-resolution fills only the half of the location it left unsaid.
 */
function applyOverrides(
  base: RolePinnedParams,
  overrides: RoleOverrides,
  deps: RoleValidatorDeps,
): RolePinnedParams {
  const harnessId = overrides.harnessId ?? base.harnessId;
  const reasoningEffort = overrides.reasoningEffort ?? base.reasoningEffort;
  if (overrides.modelId !== undefined) {
    const located = locateModel(overrides.modelId, overrides, harnessId, deps);
    if (!located) {
      throw new ServiceError(
        400,
        `No model "${overrides.modelId}" is offered by any service`
          + `${overrides.serviceId ? ` on ${overrides.serviceId}` : ""}.`,
      );
    }
    return { kind: "pinned", harnessId, ...located, reasoningEffort };
  }
  return {
    kind: "pinned",
    harnessId,
    serviceId: overrides.serviceId ?? base.serviceId,
    billingMode: overrides.billingMode ?? base.billingMode,
    modelId: overrides.modelId ?? base.modelId,
    reasoningEffort,
  };
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
    reasoningEffort: params.reasoningEffort,
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
  const reasoningLabel = harness?.capabilities.reasoning?.options.find(
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
    reasoningEffort: params.reasoningEffort,
    ...(reasoningLabel ? { reasoningLabel } : {}),
  };
}
