/**
 * docs/272-user-selectable-roles — **a role the USER started**, as opposed to one an agent
 * started.
 *
 * docs/264 built roles and gave agents two ways to start one (`shipit agent run
 * --role`, `shipit session create --role`). This module is the third way: the
 * user picks a role in the composer, and the session runs on it.
 *
 * Three functions, one per moment:
 *
 *  - {@link resolveUserRole} — name in, params out, **or a refusal by name**. It
 *    is the only place that knows which roles a user may start.
 *  - {@link applyRoleToSession} — writes those params onto the session row,
 *    exactly as the three composer controls write them. After it runs, a
 *    role-seeded session is indistinguishable from one configured by hand, which
 *    is req 3 ("a role is a starting point, not a binding") as an implementation
 *    property rather than a promise.
 *  - {@link takeRoleStandingInstructions} — the one-shot that delivers a role's
 *    standing instructions to the session's first turn (req 2).
 *
 * **Why this does not call `resolveRoleByName`.** That function's job is a role
 * plus a caller's overrides, including the reviewer's `auto` params, which need
 * an `ImplementerContext` to rank against. The user path has neither: overrides
 * are an agent-facing feature (docs/264 req 10) and the reviewer is refused here
 * (req 10 of this feature), so only `pinned` params ever reach it. Calling
 * `checkRolePinnedParams` directly means no ranking, no fabricated implementer
 * and no `auto` branch to carry — and the refusal rules stay in exactly one
 * place, since that is the validator both paths share.
 */

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

/** What {@link resolveUserRole} reads: the role store, plus the validator's own deps. */
export interface UserRoleDeps extends RoleValidatorDeps {
  credentialStore: RoleValidatorDeps["credentialStore"] & Pick<CredentialStore, "getRole" | "getRoles">;
}

/** A role the user may start, with the tuple it runs on. */
export interface ResolvedUserRole {
  role: AgentRole;
  params: RolePinnedParams;
}

/**
 * Every role a **user** may start, in the order Settings lists them.
 *
 * The reviewer is filtered out here rather than at each caller (req 10): it
 * resolves its params per run against whatever produced the work, and a session
 * the user starts themselves has no such thing — the rule would have nothing to
 * measure and would resolve to an arbitrary agent while looking deliberate.
 *
 * Unavailable roles are NOT filtered out. Req 9 is explicit that a role the
 * install cannot run stays visible with its reason, because a role the user
 * configured vanishing reads as a fault in ShipIt. The refusal below is what
 * stops one being *started*.
 */
export function listUserSelectableRoles(deps: UserRoleDeps): AgentRole[] {
  return deps.credentialStore.getRoles().filter((role) => role.name !== RESERVED_ROLE_NAME);
}

/**
 * Is there at least one role a user could start? — req 16's condition for the
 * composer showing anything about roles at all.
 *
 * **The reviewer does not count**, which is the whole reason this is a named
 * function rather than `getRoles().length > 0` at the call site. The reviewer is
 * present on every install including one where nobody has configured anything
 * (docs/264 req 2), so counting it would make this always true and req 16 dead
 * on arrival.
 */
export function hasUserSelectableRole(deps: UserRoleDeps): boolean {
  return listUserSelectableRoles(deps).length > 0;
}

/**
 * The sentence a role's unavailability is refused with — the same three states
 * docs/264 distinguishes, because the remedy differs in each and collapsing them
 * sends the user to the wrong place.
 */
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

/**
 * Turn a role name the user picked into the tuple a session starts on, or refuse
 * it by name.
 *
 * **Nothing is ever substituted** (req 8, inheriting docs/264 req 7). Three
 * refusals, and each one names what the user has to do about it:
 *
 *  - an **unknown** name — most often a role deleted in another tab, or a seed
 *    that outlived the role it names;
 *  - the **reserved reviewer** (req 10);
 *  - a role that **cannot run right now** — stranded, disconnected or out of
 *    quota, told apart by {@link checkRolePinnedParams}'s own discriminator.
 *
 * A caller that refuses must not have written anything first. Every mutation in
 * this module is downstream of this function for exactly that reason.
 */
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
    // `checkRolePinnedParams` reports the KIND of fault; `resolveRoleView` maps
    // it to the same three user-facing states Settings shows. Quota exhaustion
    // is not a check failure at all — it is a routing answer — so a role that
    // passes here can still be `quota_exhausted` when it runs. That is docs/264's
    // split, unchanged: this refuses what an edit or a reconnect fixes.
    throw new ServiceError(
      400,
      unavailableMessage(name, checked.kind === "credential" ? "disconnected" : "stranded", checked.message),
    );
  }
  return { role, params: checked.params };
}

/** What {@link applyRoleToSession} writes through. */
export interface ApplyRoleDeps {
  sessionManager: Pick<
    SessionManager,
    "setAgentId" | "setModelSelection" | "setReasoning" | "setRoleName"
  >;
}

/**
 * Seed a session from a role: its harness, its model selection, its reasoning
 * level, and the record that the role is in force.
 *
 * **The writes are the ordinary ones.** A role does not get its own column for
 * "the model a role chose" — it writes the same `agent_id`, `service_id`,
 * `billing_mode`, `model` and `reasoning_effort` the three composer controls
 * write. That is what makes req 3 true by construction: by the time a turn
 * starts, nothing downstream can tell a role-seeded session from a hand-configured
 * one, so there is no second code path for a role to diverge on.
 *
 * `setRoleName` goes **last**, and deliberately: the three parameter writes are
 * what a user moving a control would do, and those clear the role at their own
 * call sites. Writing the name first would leave it to be cleared by the very
 * writes that are applying it.
 */
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
  // `null` is the store's "no level", which is what a harness declaring none
  // resolves to (docs/274 req 8).
  deps.sessionManager.setReasoning(sessionId, params.reasoningEffort ?? null);
  deps.sessionManager.setRoleName(sessionId, role.name);
}

/** What {@link takeRoleStandingInstructions} reads and latches. */
export interface RoleInstructionsDeps {
  sessionManager: Pick<SessionManager, "get" | "setOriginRoleName">;
  credentialStore: Pick<CredentialStore, "getRole">;
}

/**
 * The role's standing instructions for this session's **first turn**, or an
 * empty string — and the latch that makes it happen exactly once (req 2).
 *
 * **Why the prompt channel and not the system prompt.** CLAUDE.md's prompt-cache
 * contract is load-bearing: every system-instruction variant renders once at
 * module load into a frozen constant, so the per-turn path is a pure lookup and
 * the CLI string stays byte-stable. A role's standing instructions are
 * per-session *user data*; putting them there would make composition per-call
 * and break that contract for every session, role or no role. A sub-agent
 * started from a role has always taken them through the prompt (docs/264 req 8),
 * and this is the same join.
 *
 * **Why `originRoleName` is the latch.** It is write-once and it is written at
 * exactly the moment req 4 says a role stops being selectable — the session's
 * first turn — so "have the instructions been delivered?" and "has this session
 * started?" are the same question and cannot drift apart into two flags. Three
 * behaviours fall out of it and none needs its own rule:
 *
 *  - turn 1 of a role-seeded session gets the instructions; turns 2+ do not,
 *    because they are already in the transcript;
 *  - an agent-spawned child is skipped — `originRoleName` was written at its
 *    creation and docs/264 already joined the role's prompt into the creating
 *    task, so it cannot be delivered twice;
 *  - req 6's record gets written for a user-started session, which nothing else
 *    was doing.
 *
 * Called from `prompt-assembly`'s two entry points (the WS turn and the
 * dispatched turn), so quick capture and the composer share it.
 *
 * **The block is tagged rather than headed**, unlike `joinRolePrompt`'s
 * `## Standing instructions` heading. That function joins two halves of a
 * sub-agent's single prompt channel, where a heading is the framing; here the
 * instructions sit beside `<attached_images>` and `<dictated_input>` in
 * `assembleAgentPrompt`, whose convention is a tagged context block the user
 * never sees. Matching the neighbours is what keeps this out of the transcript.
 */
export function takeRoleStandingInstructions(
  sessionId: string,
  deps: RoleInstructionsDeps,
): string {
  const session = deps.sessionManager.get(sessionId);
  const roleName = session?.roleName;
  if (!roleName || session.originRoleName) return "";
  // Provenance first, and unconditionally: req 6 records what the session was
  // started as whether or not the role carries any standing instructions, and
  // the latch has to close even for a role with nothing to say — otherwise a
  // prompt-less role re-asks this question on every turn forever.
  deps.sessionManager.setOriginRoleName(sessionId, roleName);
  const role = deps.credentialStore.getRole(roleName);
  const prompt = role?.prompt?.trim();
  if (!prompt) return "";
  return `<role_instructions role="${roleName}">\n${prompt}\n</role_instructions>`;
}
