/**
 * docs/264 phase 2 (reqs 5, 6, 8, 9, 17, 18) — an **edit to a role**, as it
 * arrives from the Settings screen.
 *
 * Phase 1 owns what a role runs on (`roles.ts`: the harness-explicit validator,
 * the resolver, the payload projection). This owns turning a screen's edit back
 * into stored roles, and it is deliberately **not a new set of routes**: role
 * CRUD rides `PUT /api/settings` beside the reviewer slots, so one mutation
 * surface answers "change my agent settings" and one response carries the whole
 * resolved list back.
 *
 * Four rules shape it.
 *
 * **1. The whole role is written at once** (req 17). The editor holds a name, a
 * description, standing instructions and five parameters; saving is one write
 * rather than a control-by-control trickle, so a role never exists in a
 * half-edited state on disk.
 *
 * **2. Uniqueness is the only name rule** (req 18), and {@link RoleWrite}'s
 * `previousName` is what makes it checkable. A create and an edit are otherwise
 * the same request, so without it a create colliding with an existing name would
 * silently overwrite the role it collided with instead of being refused.
 *
 * **3. A rename is a write plus a delete**, not a primitive. Nothing holds a
 * reference to a role's name, so an atomic rename would buy nothing — and the
 * reviewer, the one name that IS referenced, cannot be renamed at all (req 2).
 *
 * **4. Every entry is validated before ANY entry is written.** The same rule
 * `saveGlobalSettings` applies to the reviewer slots, for the same reason: a
 * batch that persisted its first entry and then answered 400 would leave the
 * caller told the write failed while half of it landed. Here it also keeps a
 * rename atomic — the new name is never written when the old one's delete would
 * have been refused.
 *
 * The params themselves are checked by phase 1's harness-explicit validator
 * ({@link validateRolePinnedParams}), never by a second copy of its rules: req 6
 * says a role whose harness cannot run its model is refused when it is saved,
 * and that is the function that decides it.
 */

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

/** One validated edit, ready to write. `role === null` is a delete. */
export interface RoleWritePlan {
  /** The name the role has AFTER the write. */
  name: string;
  /** The name it had before, when this edits an existing role. */
  previousName?: string;
  role: AgentRole | null;
}

/**
 * Parse one entry of the `roles` map, or throw a 400 naming the field.
 *
 * `unknown` in, because this arrives straight off an HTTP body — the same
 * boundary `parseReviewerPinPatch` sits on, and for the same reason: a declared
 * body shape would let Fastify's coercion answer first, with a worse message.
 */
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

/**
 * Every entry validated, in one pass, with nothing written yet.
 *
 * Exported separately from {@link applyRoleWrites} so the two-pass guarantee is
 * testable as a guarantee rather than inferred from the absence of a bug.
 */
export function planRoleWrites(
  roles: Record<string, unknown>,
  store: Pick<CredentialStore, "getRole">,
  deps: RoleValidatorDeps,
): RoleWritePlan[] {
  const plans: RoleWritePlan[] = [];
  // No in-batch name bookkeeping, deliberately: the map's KEYS are the names the
  // roles will have, and an object cannot hold one key twice — so two entries of
  // one batch can never claim the same final name. Each entry is checked against
  // the store as it stands before the batch, which is the state a refusal
  // describes.
  for (const [name, raw] of Object.entries(roles)) {
    requireStorableName(name);
    const write = parseRoleWrite(raw, name);
    if (write === null) {
      if (name === RESERVED_ROLE_NAME) {
        throw new ServiceError(
          400,
          `The "${RESERVED_ROLE_NAME}" role cannot be deleted — "review this" has to keep `
            + "resolving to something (docs/264 req 2).",
        );
      }
      plans.push({ name, role: null });
      continue;
    }
    plans.push(planOne(name, write, store, deps));
  }
  return plans;
}

/**
 * Validate every entry, then write them (reqs 5, 17).
 *
 * A rename writes the new name first and deletes the old one second. That order
 * is the safe one under a crash: the worst outcome is two roles where there
 * should be one, which the user can see and delete, rather than none at all.
 */
export function applyRoleWrites(
  roles: unknown,
  store: Pick<CredentialStore, "getRole" | "setRole">,
  deps: RoleValidatorDeps,
): void {
  // The container itself, before its entries — `null` is an object to `typeof`
  // and a scalar would iterate to nothing and be accepted as a silent no-op.
  if (roles === null || typeof roles !== "object" || Array.isArray(roles)) {
    throw new ServiceError(400, "roles must be an object keyed by role name");
  }
  const plans = planRoleWrites(roles as Record<string, unknown>, store, deps);
  for (const plan of plans) {
    store.setRole(plan.name, plan.role);
    if (plan.previousName && plan.previousName !== plan.name) {
      store.setRole(plan.previousName, null);
    }
  }
}

// ---- Internals -------------------------------------------------------------

function planOne(
  name: string,
  write: RoleWrite,
  store: Pick<CredentialStore, "getRole">,
  deps: RoleValidatorDeps,
): RoleWritePlan {
  const { previousName } = write;
  // The reserved name's rules, all three of them together: it is always present,
  // its params are ShipIt's, and it answers to no other name (req 2).
  if (previousName === RESERVED_ROLE_NAME && name !== RESERVED_ROLE_NAME) {
    throw new ServiceError(
      400,
      `The "${RESERVED_ROLE_NAME}" role cannot be renamed — "review this" has to keep resolving `
        + "to something (docs/264 req 2). Its description and standing instructions are editable.",
    );
  }
  if (name === RESERVED_ROLE_NAME) {
    if (previousName !== RESERVED_ROLE_NAME) {
      throw new ServiceError(
        400,
        `"${RESERVED_ROLE_NAME}" is reserved for the role ShipIt ships (docs/264 req 2). `
          + "Choose another name.",
      );
    }
    if (write.params.kind !== "auto") {
      throw new ServiceError(
        400,
        `The "${RESERVED_ROLE_NAME}" role's params are resolved by ShipIt and cannot be pinned `
          + "(docs/264 req 2). Its description and standing instructions are editable.",
      );
    }
  } else if (write.params.kind === "auto") {
    throw new ServiceError(
      400,
      `Only the "${RESERVED_ROLE_NAME}" role may have automatic params (docs/264 req 2); `
        + `"${name}" must name a harness, a service, a billing mode, a model and a level.`,
    );
  }

  // Uniqueness (req 18) — the only rule a name has. A create may not land on a
  // name that exists; a rename may not land on one either.
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
  const params: RoleParams =
    write.params.kind === "pinned"
      ? validateRolePinnedParams(write.params, deps, `The role "${name}"`)
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

/**
 * The params, or a 400 naming what is wrong with their *shape*.
 *
 * Shape only: whether the tuple can actually run is
 * {@link validateRolePinnedParams}'s question, and asking it here would be the
 * second copy of req 6's rules this module exists not to have.
 */
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
  // Every field required, because req 1 says a role is complete on its own —
  // and the harness among them, because req 6 says it is never re-derived.
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
  if (typeof reasoningEffort !== "string" || !reasoningEffort) {
    throw new ServiceError(400, `roles["${name}"].params.reasoningEffort is required`);
  }
  return {
    kind: "pinned",
    // Cast rather than checked against the `AgentId` union here, the same
    // boundary `sub-agent-target.ts` casts at: an unknown harness id is refused
    // by `checkRolePinnedParams` with `No harness named "x"`, which is the
    // refusal that names the parameter. A shape check here would answer first
    // and say only that the field is a string.
    harnessId: harnessId as RolePinnedParams["harnessId"],
    serviceId,
    billingMode,
    modelId,
    reasoningEffort,
  };
}

/**
 * Blank and pathologically long are the only two names refused (req 18).
 *
 * Mirrors `CredentialStore.setRole`'s own guards rather than relying on them,
 * so a bad name is a 400 naming the field instead of a 500 from a store that
 * throws a plain `Error` — and so the whole batch is refused before anything is
 * written. **Nothing is normalized**: a name is stored exactly as typed, so
 * `" reviewer "` stays a distinct ordinary role rather than becoming the
 * reserved one.
 */
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

/**
 * A trimmed field, or `undefined` when it is empty — which is how the editor
 * clears one (reqs 8, 9 make both optional).
 */
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
