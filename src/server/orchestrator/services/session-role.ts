import type {
  AgentRole,
  RolePinnedParams,
  RoleUnavailableReason,
} from "../../shared/types/agent-types.js";
import { RESERVED_ROLE_NAME } from "../../shared/types/agent-types.js";
import type { SessionManager } from "../sessions.js";
import type { CredentialStore } from "../credential-store.js";
import { checkRolePinnedParams, type RoleValidatorDeps } from "./roles.js";
import { ServiceError } from "./types.js";

export interface UserRoleDeps extends RoleValidatorDeps {
  credentialStore: RoleValidatorDeps["credentialStore"] & Pick<CredentialStore, "getRole" | "getRoles">;
}

export interface ResolvedUserRole {
  role: AgentRole;
  params: RolePinnedParams;
}

export function listUserSelectableRoles(deps: UserRoleDeps): AgentRole[] {
  return deps.credentialStore.getRoles().filter((role) => role.name !== RESERVED_ROLE_NAME);
}

function unavailableMessage(name: string, reason: RoleUnavailableReason, detail: string): string {
  switch (reason) {
    case "stranded":
      return `The role "${name}" cannot run: ${detail} Edit it in Settings → Roles.`;
    case "disconnected":
      return `The role "${name}" cannot run: ${detail} Reconnect the service in Settings.`;
    case "quota_exhausted":
      return `The role "${name}" cannot run right now: its subscription is spent. It works again when the quota resets.`;
  }
}

export function resolveUserRole(name: string, deps: UserRoleDeps): ResolvedUserRole {
  const role = deps.credentialStore.getRole(name);
  if (!role) {
    const known = listUserSelectableRoles(deps).map((r) => r.name);
    throw new ServiceError(
      400,
      known.length > 0
        ? `Unknown role "${name}". Roles on this install: ${known.join(", ")}.`
        : `Unknown role "${name}". No roles are configured — create one in Settings → Roles.`,
    );
  }
  if (role.name === RESERVED_ROLE_NAME || role.params.kind !== "pinned") {
    throw new ServiceError(
      400,
      `The "${RESERVED_ROLE_NAME}" role picks the agent furthest from whatever produced the work, `
        + "so it only means something when an agent starts it. Pick another role.",
    );
  }
  const checked = checkRolePinnedParams(role.params, deps);
  if (!checked.ok) {
    throw new ServiceError(
      400,
      unavailableMessage(name, checked.kind === "credential" ? "disconnected" : "stranded", checked.message),
    );
  }
  return { role, params: checked.params };
}

export interface ApplyRoleDeps {
  sessionManager: Pick<
    SessionManager,
    "setAgentId" | "setModelSelection" | "setReasoning" | "setRoleName"
  >;
}

export function applyRoleToSession(
  sessionId: string,
  resolved: ResolvedUserRole,
  deps: ApplyRoleDeps,
): void {
  const { params, role } = resolved;
  deps.sessionManager.setAgentId(sessionId, params.harnessId);
  deps.sessionManager.setModelSelection(sessionId, {
    serviceId: params.serviceId,
    billingMode: params.billingMode,
    modelId: params.modelId,
  });
  // null clears the previous level; undefined would leave it unchanged.
  deps.sessionManager.setReasoning(sessionId, params.reasoningEffort ?? null);
  deps.sessionManager.setRoleName(sessionId, role.name);
}

export interface RoleInstructionsDeps {
  sessionManager: Pick<SessionManager, "get" | "setOriginRoleName">;
  credentialStore: Pick<CredentialStore, "getRole">;
}

// Per-session instructions belong in the task prompt to keep system prompts stable.
// Spawned children already have originRoleName and received the instructions at creation.
export function takeRoleStandingInstructions(
  sessionId: string,
  deps: RoleInstructionsDeps,
): string {
  const session = deps.sessionManager.get(sessionId);
  const roleName = session?.roleName;
  if (!roleName || session.originRoleName) return "";
  // Record the origin even when the role has no prompt.
  deps.sessionManager.setOriginRoleName(sessionId, roleName);
  const role = deps.credentialStore.getRole(roleName);
  const prompt = role?.prompt?.trim();
  if (!prompt) return "";
  return `<role_instructions role="${roleName}">\n${prompt}\n</role_instructions>`;
}
