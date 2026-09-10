import type {
  AgentId,
  ReviewerSlot,
  RoleOverrides,
  SessionInfo,
  SpawnTarget,
  SubAgentSpawnTarget,
} from "../../shared/types.js";
import { RESERVED_ROLE_NAME } from "../../shared/types.js";
import type { BillingMode, ModelSelection } from "../../shared/catalogue/types.js";
import {
  getHarness,
  getModel,
  harnessSendsReasoningEffort,
  reasoningOptionsFor,
  resolveStyle,
  selectionExists,
} from "../../shared/catalogue/index.js";
import type { ProviderRoute } from "../provider-account-manager.js";
import { parseSpawnIdentity } from "../service-routing.js";
import { selectionOf } from "../turn-attribution.js";
import type {
  ImplementerContext,
  ReviewerModelDeps,
  ReviewerSource,
  ReviewerTier,
} from "../reviewer-model.js";
import { resolveRoleByName, type RoleDeps } from "./roles.js";
import { ServiceError } from "./types.js";

export interface SubAgentSpawnTargetBody {
  role?: unknown;
  noRole?: unknown;
  agentId?: unknown;
  serviceId?: unknown;
  billingMode?: unknown;
  modelId?: unknown;
  reasoningEffort?: unknown;
}

const EXPLICIT_FIELDS = [
  { field: "agentId", flag: "--agent" },
  { field: "serviceId", flag: "--service" },
  { field: "billingMode", flag: "--billing-mode" },
  { field: "modelId", flag: "--model" },
  { field: "reasoningEffort", flag: "--effort" },
] as const;

// Levels depend on selection and billing; incomplete identities use the harness vocabulary.
function effortIsRequired(body: SubAgentSpawnTargetBody): boolean | undefined {
  const agentId = str(body.agentId);
  if (agentId === undefined) return undefined;
  const serviceId = str(body.serviceId);
  const rawMode = str(body.billingMode);
  const modelId = str(body.modelId);
  const billingMode = rawMode === "sub" || rawMode === "key" ? rawMode : undefined;
  if (serviceId && modelId && billingMode) {
    return reasoningOptionsFor(agentId as AgentId, { serviceId, billingMode, modelId }).length > 0;
  }
  if (billingMode) return harnessSendsReasoningEffort(agentId as AgentId, billingMode);
  const options = getHarness(agentId as AgentId)?.capabilities.reasoning?.options ?? [];
  return options.length > 0;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readBillingMode(value: unknown): BillingMode {
  const mode = str(value);
  if (mode !== "sub" && mode !== "key") {
    throw new ServiceError(
      400,
      `--billing-mode must be "sub" or "key", not "${String(value)}".`,
    );
  }
  return mode;
}

// null means absent; a blank named value must not silently inherit from the base.
function readNamed(value: unknown, flag: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = str(value);
  if (text === undefined) {
    throw new ServiceError(
      400,
      `${flag} was given an empty value. Pass a value, or omit the flag entirely — `
        + "a named parameter is never silently dropped.",
    );
  }
  return text;
}

// Role names are exact store keys; preserve surrounding spaces.
function readRoleName(value: unknown): string | undefined {
  return readNamed(value, "--role") === undefined ? undefined : (value as string);
}

function readOverrides(body: SubAgentSpawnTargetBody): RoleOverrides {
  const harnessId = readNamed(body.agentId, "--agent");
  const serviceId = readNamed(body.serviceId, "--service");
  const modelId = readNamed(body.modelId, "--model");
  const reasoningEffort = readNamed(body.reasoningEffort, "--effort");
  return {
    ...(harnessId ? { harnessId: harnessId as AgentId } : {}),
    ...(serviceId ? { serviceId } : {}),
    ...(body.billingMode !== undefined && body.billingMode !== null
      ? { billingMode: readBillingMode(body.billingMode) }
      : {}),
    ...(modelId ? { modelId } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

export function parseSpawnTarget(
  body: SubAgentSpawnTargetBody,
  opts: { parentBase: boolean },
): SpawnTarget {
  const role = readRoleName(body.role);
  const noRole = body.noRole === true;
  if (noRole && role !== undefined) {
    throw new ServiceError(
      400,
      "--no-role and --role name opposite things. Pass --role NAME to run that role, "
        + "or --no-role to decline the role the parent session is running.",
    );
  }
  if (noRole && !opts.parentBase) {
    throw new ServiceError(
      400,
      "--no-role applies to a spawn that inherits from a parent session. A one-shot run has no "
        + "parent and therefore no role to decline — name a role, or name every parameter.",
    );
  }
  if (role !== undefined) {
    return { kind: "role", role, overrides: readOverrides(body) };
  }

  const effortRequired = effortIsRequired(body);
  const missing = EXPLICIT_FIELDS.filter(
    (f) =>
      (f.field !== "reasoningEffort" || effortRequired !== false)
      && str(body[f.field]) === undefined,
  );
  if (missing.length === 0) {
    // Optional effort still rejects a blank named value.
    const reasoningEffort = readNamed(body.reasoningEffort, "--effort");
    return {
      kind: "explicit",
      harnessId: str(body.agentId) as AgentId,
      serviceId: str(body.serviceId)!,
      billingMode: readBillingMode(body.billingMode),
      modelId: str(body.modelId)!,
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    };
  }
  if (opts.parentBase) {
    return { kind: "inherit", overrides: readOverrides(body), ...(noRole ? { noRole } : {}) };
  }
  throw new ServiceError(
    400,
    "A run that names no role must name every parameter it runs on — missing "
      + `${missing.map((f) => f.flag).join(", ")}. Nothing is filled in from a stored setting. `
      + `Use --role ${RESERVED_ROLE_NAME} (or any role you configured) to run one instead.`,
  );
}

export function parseSubAgentSpawnTarget(body: SubAgentSpawnTargetBody): SubAgentSpawnTarget {
  return parseSpawnTarget(body, { parentBase: false }) as SubAgentSpawnTarget;
}

export interface ResolvedSpawnTarget {
  harnessId: AgentId;
  selection: ModelSelection;
  reasoningEffort?: string;
  // Freeze a ranked reviewer's credential for one-shot retries, never child sessions.
  route?: ProviderRoute;
  reviewer?: {
    slot: ReviewerSlot;
    source: ReviewerSource;
    tier: ReviewerTier;
    tierBasis: "model-and-harness" | "harness-only";
  };
  // Attribution snapshot, not a live link to the role.
  roleName?: string;
  rolePrompt?: string;
}

export type ResolveSpawnTargetDeps = RoleDeps & ReviewerModelDeps;

function resolveSpawnTarget(
  target: SubAgentSpawnTarget,
  implementer: ImplementerContext,
  deps: ResolveSpawnTargetDeps,
): ResolvedSpawnTarget {
  if (target.kind === "explicit") {
    const harness = getHarness(target.harnessId);
    if (!harness) {
      throw new ServiceError(400, `Unknown agent: ${target.harnessId}`);
    }
    const selection: ModelSelection = {
      serviceId: target.serviceId,
      billingMode: target.billingMode,
      modelId: target.modelId,
    };
    if (!selectionExists(selection)) {
      throw new ServiceError(
        400,
        `No model "${target.modelId}" is offered by ${target.serviceId} on the `
          + `"${target.billingMode}" billing mode.`,
      );
    }
    const model = getModel(selection);
    if (model && resolveStyle(target.harnessId, model) === undefined) {
      throw new ServiceError(
        400,
        `${harness.name} cannot run ${model.label} — they share no API style.`,
      );
    }
    const options = reasoningOptionsFor(target.harnessId, selection);
    if (options.length === 0 && target.reasoningEffort !== undefined) {
      throw new ServiceError(
        400,
        `${harness.name} offers no reasoning levels on ${model?.label ?? target.modelId} — omit --effort. `
          + "A complete call on it is the other four flags.",
      );
    }
    if (options.length > 0 && target.reasoningEffort === undefined) {
      throw new ServiceError(
        400,
        `A run on ${harness.name} must name --effort. `
          + `Valid levels: ${options.map((o) => o.value).join(", ")}.`,
      );
    }
    if (options.length > 0 && !options.some((o) => o.value === target.reasoningEffort)) {
      throw new ServiceError(
        400,
        `Invalid --effort "${target.reasoningEffort}" for ${target.harnessId}. `
          + `Valid levels: ${options.map((o) => o.value).join(", ")}.`,
      );
    }
    return {
      harnessId: target.harnessId,
      selection,
      ...(target.reasoningEffort !== undefined
        ? { reasoningEffort: target.reasoningEffort }
        : {}),
    };
  }

  const resolved = resolveRoleByName(target.role, target.overrides, implementer, deps);
  return {
    harnessId: resolved.harnessId,
    selection: { ...resolved.selection },
    ...(resolved.reasoningEffort !== undefined ? { reasoningEffort: resolved.reasoningEffort } : {}),
    roleName: resolved.roleName,
    ...(resolved.prompt ? { rolePrompt: resolved.prompt } : {}),
    ...(resolved.route ? { route: { ...resolved.route } } : {}),
    ...(resolved.reviewer ? { reviewer: { ...resolved.reviewer } } : {}),
  };
}

export const resolveSubAgentSpawnTarget = resolveSpawnTarget;

// Child turns route independently so they retain account failover.
export function resolveSpawnTargetForChild(
  target: SubAgentSpawnTarget,
  implementer: ImplementerContext,
  deps: ResolveSpawnTargetDeps,
): ResolvedSpawnTarget {
  const { route: _route, reviewer: _reviewer, ...rest } = resolveSpawnTarget(
    target,
    implementer,
    deps,
  );
  return rest;
}

// Rank against the running process; the session selection can change before respawn.
export function implementerFor(
  session: SessionInfo,
  harnessId: AgentId,
  appliedSpawnIdentity: string | undefined,
): ImplementerContext {
  const captured = parseSpawnIdentity(appliedSpawnIdentity);
  return {
    harnessId,
    selection:
      captured?.harnessId === harnessId && captured.selection
        ? captured.selection
        : selectionOf(session),
  };
}

// Check API-style compatibility first in resolveSpawnTarget so this error names the missing credential.
export function assertHarnessCanRunSelection(
  harnessName: string,
  eligibleModels: readonly ModelSelection[] | undefined,
  selection: ModelSelection,
): void {
  const eligible = eligibleModels ?? [];
  if (eligible.length === 0) return;
  const match = eligible.some(
    (m) =>
      m.serviceId === selection.serviceId
      && m.billingMode === selection.billingMode
      && m.modelId === selection.modelId,
  );
  if (match) return;
  const label = getModel(selection)?.label ?? selection.modelId;
  throw new ServiceError(
    400,
    `${harnessName} cannot run ${label} on ${selection.serviceId}/${selection.billingMode} — `
      + "no credential this harness can use offers it.",
  );
}
