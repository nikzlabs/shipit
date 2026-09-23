import type {
  AgentRole,
  RolePinnedParams,
  RoleUnavailableReason,
} from "../../shared/types/agent-types.js";
import { RESERVED_ROLE_NAME } from "../../shared/types/agent-types.js";
import type { SessionManager } from "../sessions.js";
import type { CredentialStore } from "../credential-store.js";
import { namesForMessage } from "../../shared/settings-catalogue/projection.js";
import { renderLine } from "../../shared/settings-catalogue/rendered.js";
import { checkRolePinnedParams, type RoleValidatorDeps } from "./roles.js";
import { createPromptRepark, type PromptRepark } from "../turn-settlement.js";
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
      return `The role "${name}" cannot run: ${detail} Reconnect the provider in Settings.`;
    case "quota_exhausted":
      return `The role "${name}" cannot run right now: its subscription is spent. It works again when the quota resets.`;
  }
}

/**
 * Every refusal this module raises, on ONE line — the same rule and the same
 * shape as `roles.ts` → `refuse` (docs/299-agent-settings-access req 2).
 * `shipit session create --role` reaches these from inside a session, and each
 * names either the supplied role name or the role's own stored harness,
 * service, model and level. {@link renderLine} for the same reason as there:
 * these lines embed a value another mint already quoted, and collapsing runs of
 * space would reach inside those quotes (planning#537).
 */
function refuse(message: string): never {
  throw new ServiceError(400, renderLine(message));
}

export function resolveUserRole(name: string, deps: UserRoleDeps): ResolvedUserRole {
  const role = deps.credentialStore.getRole(name);
  // The stored names go through the projection door; the supplied one is
  // echoed, being the caller's own argument. {@link refuse} renders the line it
  // lands on, so it needs no flattening of its own.
  const shown = name;
  if (!role) {
    const known = listUserSelectableRoles(deps).map((r) => r.name);
    refuse(
      known.length > 0
        ? `Unknown role "${shown}". Roles on this install: ${namesForMessage(known)}.`
        : `Unknown role "${shown}". No roles are configured — create one in Settings → Roles.`,
    );
  }
  if (role.name === RESERVED_ROLE_NAME || role.params.kind !== "pinned") {
    refuse(
      `The "${RESERVED_ROLE_NAME}" role picks the agent furthest from whatever produced the work, `
        + "so it only means something when an agent starts it. Pick another role.",
    );
  }
  const checked = checkRolePinnedParams(role.params, deps);
  if (!checked.ok) {
    refuse(
      unavailableMessage(shown, checked.kind === "credential" ? "disconnected" : "stranded", checked.message),
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
  sessionManager: Pick<SessionManager, "get" | "setOriginRoleName" | "clearOriginRoleName">;
  credentialStore: Pick<CredentialStore, "getRole">;
}

export interface RoleStandingInstructions {
  instructions: string;
  /**
   * Present only when this call performed the take, which is not the same as returning
   * instructions: a role with no prompt still marks its origin, and a turn that dies
   * before the agent runs must hand that marker back too (planning#609).
   */
  repark?: PromptRepark;
}

// Per-session instructions belong in the task prompt to keep system prompts stable.
// Spawned children already have originRoleName and received the instructions at creation.
export function takeRoleStandingInstructions(
  sessionId: string,
  deps: RoleInstructionsDeps,
): RoleStandingInstructions {
  const session = deps.sessionManager.get(sessionId);
  const roleName = session?.roleName;
  if (!roleName || session.originRoleName) return { instructions: "" };
  // Record the origin even when the role has no prompt.
  deps.sessionManager.setOriginRoleName(sessionId, roleName);
  // Scoped to the name this call recorded, so a role applied mid-turn keeps its own take.
  const repark = createPromptRepark(
    `the "${roleName}" standing brief for ${sessionId}`,
    () => { deps.sessionManager.clearOriginRoleName(sessionId, roleName); },
  );
  const role = deps.credentialStore.getRole(roleName);
  const prompt = role?.prompt?.trim();
  if (!prompt) return { instructions: "", repark };
  return {
    instructions: `<role_instructions role="${roleName}">\n${prompt}\n</role_instructions>`,
    repark,
  };
}
