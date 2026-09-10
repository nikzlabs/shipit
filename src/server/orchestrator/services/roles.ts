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

export interface RoleDeps extends ReviewerModelDeps {
  credentialStore: ReviewerModelDeps["credentialStore"] & Pick<CredentialStore, "getRoles" | "getRole">;
  isInstalled?: ((harnessId: AgentId) => boolean) | undefined;
}

export type RoleValidatorDeps = Pick<RoleDeps, "credentialStore" | "env" | "isInstalled">;

export type { RoleOverrides };

export interface ResolvedRoleTarget {
  readonly roleName: string;
  readonly harnessId: AgentId;
  readonly selection: Readonly<ModelSelection>;
  /** Absence leaves the reasoning level to the harness. */
  readonly reasoningEffort?: string;
  readonly prompt?: string;
  readonly overridden: boolean;
  /** Reuse the ranked route only while its harness and selection are unchanged. */
  readonly route?: Readonly<ProviderRoute>;
  readonly serviceRouting?: Readonly<ServiceRouting>;
  readonly credentialSecret?: string;
  readonly reviewer?: Readonly<{
    slot: ReviewerSlot;
    source: ReviewerSource;
    tier: ReviewerTier;
    tierBasis: "model-and-harness" | "harness-only";
  }>;
}

export type RoleInvalidField =
  | "harnessId"
  | "service"
  | "billingMode"
  | "model"
  | "reasoningEffort";

export type RoleCheckFailureKind = "catalogue" | "credential";

export type RoleParamsPurpose = "run" | "save";

export type RoleParamsCheck =
  | { ok: true; params: RolePinnedParams }
  | { ok: false; kind: RoleCheckFailureKind; field: RoleInvalidField; message: string };

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
  // A pinned role never follows a retired model's successor.
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
  const model = getModel(selection)!;
  const label = model.label;
  if (resolveStyle(harnessId, model) === undefined) {
    return {
      ok: false,
      kind: "catalogue",
      field: "harnessId",
      message: `${harness.name} cannot speak to ${label} — they share no API style.`,
    };
  }
  if (params.reasoningEffort !== undefined) {
    // Available levels depend on the selection, including its billing mode.
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
  // Report tuple faults before missing credentials; saving needs no live credential.
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

  // A complete override bypasses ranking; partial overrides need a ranked base.
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
    // Ranking already resolved the route and level; preserve that result.
    return freezeTarget(role, base, false, chosen);
  }
  const params = validateRolePinnedParams(
    applyOverrides(base, overrides, deps, "ranked"),
    deps,
    `The role "${name}" with those overrides`,
  );
  return freezeTarget(role, params, true, chosen);
}

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

function completeOverride(overrides: RoleOverrides): RolePinnedParams | undefined {
  const { harnessId, serviceId, billingMode, modelId, reasoningEffort } = overrides;
  if (!harnessId || !serviceId || !billingMode || !modelId || !reasoningEffort) return undefined;
  return { kind: "pinned", harnessId, serviceId, billingMode, modelId, reasoningEffort };
}

type OverrideBaseKind = "role" | "ranked";

// A model override can relocate a ranked selection. A pinned role keeps every
// service and billing choice the caller did not override.
function applyOverrides(
  base: RolePinnedParams,
  overrides: RoleOverrides,
  deps: RoleValidatorDeps,
  baseKind: OverrideBaseKind,
): RolePinnedParams {
  const harnessId = overrides.harnessId ?? base.harnessId;
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
  // Prefer the fewest additional flags that can reach the model.
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
    `${service?.name ?? params.serviceId} does not offer "${params.modelId}" on the `
      + `"${params.billingMode}" billing mode. Overriding the model does not move a service or `
      + `billing mode you did not name — that came from the role. Name `
      + `${remedy.flags.join(" and ")} as well; "${params.modelId}" is offered on ${offered}.`,
  );
}

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
  // Keep an offered but unusable tuple so validation reports the actual fault.
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

export const ROLE_PROMPT_LIMITS = { oneShot: 200_000, child: 50_000 } as const;

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

export function buildRoleSettings(deps: RoleDeps): RoleView[] {
  return deps.credentialStore.getRoles().map((role) => resolveRoleView(role, deps));
}

export function resolveRoleView(role: AgentRole, deps: RoleDeps): RoleView {
  const base = {
    name: role.name,
    ...(role.description ? { description: role.description } : {}),
    ...(role.prompt ? { prompt: role.prompt } : {}),
    params: role.params,
    reserved: role.name === RESERVED_ROLE_NAME,
  };
  // Auto roles have two ranked slots, supplied separately as `reviewers`.
  if (role.params.kind === "auto") return base;

  const checked = checkRolePinnedParams(role.params, deps);
  if (!checked.ok) {
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
