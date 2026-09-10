import type {
  AgentRole,
  RoleParams,
  RolePinnedParams,
  RoleWrite,
} from "../../shared/types/agent-types.js";
import { RESERVED_ROLE_NAME } from "../../shared/types/agent-types.js";
import type { CredentialStore } from "../credential-store.js";
import {
  MAX_ROLE_DESCRIPTION_LENGTH,
  MAX_ROLE_NAME_LENGTH,
  MAX_ROLE_PROMPT_LENGTH,
} from "../credential-store.js";
import { validateRolePinnedParams, type RoleValidatorDeps } from "./roles.js";
import { ServiceError } from "./types.js";

export interface RoleWritePlan {
  name: string;
  previousName?: string;
  role: AgentRole | null;
}

export function parseRoleWrite(raw: unknown, name: string): RoleWrite | null {
  if (raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ServiceError(400, `roles["${name}"] must be a role object or null`);
  }
  const value = raw as Record<string, unknown>;
  const { previousName, description, prompt, params } = value;
  if (previousName !== undefined && (typeof previousName !== "string" || !previousName)) {
    throw new ServiceError(400, `roles["${name}"].previousName must be a non-empty string`);
  }
  if (description !== undefined && typeof description !== "string") {
    throw new ServiceError(400, `roles["${name}"].description must be a string`);
  }
  if (prompt !== undefined && typeof prompt !== "string") {
    throw new ServiceError(400, `roles["${name}"].prompt must be a string`);
  }
  return {
    ...(previousName !== undefined ? { previousName } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    params: parseRoleParams(params, name),
  };
}

export function planRoleWrites(
  roles: Record<string, unknown>,
  store: Pick<CredentialStore, "getRole">,
  deps: RoleValidatorDeps,
): RoleWritePlan[] {
  const plans: RoleWritePlan[] = [];
  for (const [name, raw] of Object.entries(roles)) {
    requireStorableName(name);
    const write = parseRoleWrite(raw, name);
    if (write === null) {
      if (name === RESERVED_ROLE_NAME) {
        throw new ServiceError(
          400,
          `The "${RESERVED_ROLE_NAME}" role cannot be deleted — "review this" has to keep `
            + "resolving to something (docs/264-agent-roles req 2).",
        );
      }
      plans.push({ name, role: null });
      continue;
    }
    plans.push(planOne(name, write, store, deps));
  }
  return plans;
}

export function applyRoleWrites(
  roles: unknown,
  store: Pick<CredentialStore, "getRole" | "setRole">,
  deps: RoleValidatorDeps,
): void {
  if (roles === null || typeof roles !== "object" || Array.isArray(roles)) {
    throw new ServiceError(400, "roles must be an object keyed by role name");
  }
  // Validate the whole batch before any write.
  const plans = planRoleWrites(roles as Record<string, unknown>, store, deps);
  for (const plan of plans) {
    // Create before deleting the old name so a crash cannot lose both copies.
    store.setRole(plan.name, plan.role);
    if (plan.previousName && plan.previousName !== plan.name) {
      store.setRole(plan.previousName, null);
    }
  }
}

function planOne(
  name: string,
  write: RoleWrite,
  store: Pick<CredentialStore, "getRole">,
  deps: RoleValidatorDeps,
): RoleWritePlan {
  const { previousName } = write;
  if (previousName === RESERVED_ROLE_NAME && name !== RESERVED_ROLE_NAME) {
    throw new ServiceError(
      400,
      `The "${RESERVED_ROLE_NAME}" role cannot be renamed — "review this" has to keep resolving `
        + "to something (docs/264-agent-roles req 2). Its description and standing instructions are editable.",
    );
  }
  if (name === RESERVED_ROLE_NAME) {
    if (previousName !== RESERVED_ROLE_NAME) {
      throw new ServiceError(
        400,
        `"${RESERVED_ROLE_NAME}" is reserved for the role ShipIt ships (docs/264-agent-roles req 2). `
          + "Choose another name.",
      );
    }
    if (write.params.kind !== "auto") {
      throw new ServiceError(
        400,
        `The "${RESERVED_ROLE_NAME}" role's params are resolved by ShipIt and cannot be pinned `
          + "(docs/264-agent-roles req 2). Its description and standing instructions are editable.",
      );
    }
  } else if (write.params.kind === "auto") {
    throw new ServiceError(
      400,
      `Only the "${RESERVED_ROLE_NAME}" role may have automatic params (docs/264-agent-roles req 2); `
        + `"${name}" must name a harness, a service, a billing mode, a model and a level.`,
    );
  }

  if (previousName === undefined) {
    requireNameFree(name, store);
  } else {
    if (!store.getRole(previousName)) {
      throw new ServiceError(400, `No role named "${previousName}" — it may have been deleted.`);
    }
    if (name !== previousName) {
      requireStorableName(previousName);
      requireNameFree(name, store);
    }
  }

  const description = boundedText(write.description, MAX_ROLE_DESCRIPTION_LENGTH, "description", name);
  const prompt = boundedText(write.prompt, MAX_ROLE_PROMPT_LENGTH, "standing instructions", name);
  // Validate compatibility on save; disconnected roles must remain editable.
  const params: RoleParams =
    write.params.kind === "pinned"
      ? validateRolePinnedParams(write.params, deps, `The role "${name}"`, "save")
      : write.params;
  return {
    name,
    ...(previousName !== undefined ? { previousName } : {}),
    role: {
      name,
      ...(description ? { description } : {}),
      ...(prompt ? { prompt } : {}),
      params,
    },
  };
}

function parseRoleParams(raw: unknown, name: string): RoleParams {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ServiceError(400, `roles["${name}"].params is required`);
  }
  const value = raw as Record<string, unknown>;
  if (value.kind === "auto") return { kind: "auto" };
  if (value.kind !== "pinned") {
    throw new ServiceError(400, `roles["${name}"].params.kind must be "pinned" or "auto"`);
  }
  const { harnessId, serviceId, billingMode, modelId, reasoningEffort } = value;
  if (typeof harnessId !== "string" || !harnessId) {
    throw new ServiceError(400, `roles["${name}"].params.harnessId is required`);
  }
  if (typeof serviceId !== "string" || !serviceId) {
    throw new ServiceError(400, `roles["${name}"].params.serviceId is required`);
  }
  if (billingMode !== "sub" && billingMode !== "key") {
    throw new ServiceError(400, `roles["${name}"].params.billingMode must be "sub" or "key"`);
  }
  if (typeof modelId !== "string" || !modelId) {
    throw new ServiceError(400, `roles["${name}"].params.modelId is required`);
  }
  if (reasoningEffort !== undefined && (typeof reasoningEffort !== "string" || !reasoningEffort)) {
    throw new ServiceError(
      400,
      `roles["${name}"].params.reasoningEffort must be a non-empty string, or omitted for Default`,
    );
  }
  return {
    kind: "pinned",
    harnessId: harnessId as RolePinnedParams["harnessId"],
    serviceId,
    billingMode,
    modelId,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  };
}

function requireStorableName(name: string): void {
  if (!name.trim()) throw new ServiceError(400, "A role name cannot be blank");
  if (name.length > MAX_ROLE_NAME_LENGTH) {
    throw new ServiceError(
      400,
      `A role name cannot be longer than ${MAX_ROLE_NAME_LENGTH} characters`,
    );
  }
}

function requireNameFree(name: string, store: Pick<CredentialStore, "getRole">): void {
  if (store.getRole(name)) {
    throw new ServiceError(400, `A role named "${name}" already exists. Names are unique.`);
  }
}

function boundedText(
  value: string | undefined,
  max: number,
  what: string,
  name: string,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > max) {
    throw new ServiceError(
      400,
      `The role "${name}"'s ${what} cannot be longer than ${max} characters`,
    );
  }
  return trimmed;
}
