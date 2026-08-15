/**
 * docs/264 phase 3 (req 12) — **what an agent is allowed to name**, as two reads.
 *
 * An agent can only name what it can see. Before this, it could see nothing: the
 * session shim exposed `agent run` and `agent result` and nothing that listed
 * roles, models, harnesses or levels — so an agent asked to "review with the
 * deep-dive role" had no way to know whether that role existed, and an agent
 * carrying "use Opus at high effort" named a model from memory.
 *
 * Req 12 needs two reads, and they exist for different reasons:
 *
 *  - {@link listRolesForAgent} — the **roles**: a name and, where the user wrote
 *    one, a description (req 9). This is what lets the agent map an intent onto a
 *    role (req 3) and tell the user what exists. Where a role has no description
 *    the name stands alone.
 *  - {@link listSpawnParameters} — the **parameters this install actually has**:
 *    the eligible models with their service and billing mode, the installed
 *    harnesses, and each harness's reasoning levels. This is what makes an
 *    override (req 10) name something real.
 *
 * **The second read is the one that changed a boundary this design had twice
 * drawn the other way.** While a role was a unit, withholding the catalogue kept
 * the agent out of the business of choosing parameters. Once an override is
 * allowed, withholding it does the opposite: the agent still names a model, but
 * names it from memory, and a remembered model may not exist on this install at
 * all. Allowing overrides and withholding the list is strictly the worst
 * combination, so the two ship together.
 *
 * What this is **not** is an invitation to assemble targets from scratch (req 15).
 * A role is the path, an override is a modification to it, and this list exists
 * to make the modification honest — not to make the five-parameter form
 * attractive. That rule lives in what the agent is told, because ShipIt cannot
 * tell a relayed parameter from an invented one.
 *
 * Both reads report **this install**, not the catalogue: an uninstalled harness
 * and a model with no credential are not things an override may name, and
 * listing them would produce exactly the refusals the list exists to prevent.
 */

import type { AgentId, RoleView } from "../../shared/types.js";
import type { AgentRegistry } from "../../shared/agent-registry.js";
import type { BillingMode } from "../../shared/catalogue/index.js";
import { isHarnessInstalled } from "../../shared/installed-harnesses.js";
import { buildRoleSettings, type RoleDeps } from "./roles.js";

/** One role as the agent sees it: what to name, and what it is for. */
export interface AgentRoleListing {
  name: string;
  /** Req 9 — optional; where it is absent the name is the whole answer. */
  description?: string;
  /**
   * What this role runs on today, in one line ("Claude Code · Claude Opus 5 ·
   * high"). Absent for the reviewer, whose params ShipIt resolves per run
   * (req 2), and for a role that cannot run.
   */
  runsOn?: string;
  /**
   * Why it cannot run, when it cannot — `stranded` needs a Settings edit,
   * `disconnected` needs the service reconnected, `quota_exhausted` needs
   * nothing but time. Carried so the agent relays the right remedy instead of
   * telling the user to edit a role that is perfectly correct.
   */
  unavailable?: RoleView["unavailableReason"];
}

/** One `(harness, service, billing mode, model, level)` axis, as the agent may name it. */
export interface SpawnParameterInventory {
  harnesses: {
    id: AgentId;
    name: string;
    /** The levels `--effort` may name on this harness. Empty when it declares none. */
    reasoningLevels: string[];
    /** Every model this harness can run with the credentials configured here. */
    models: {
      serviceId: string;
      billingMode: BillingMode;
      modelId: string;
      label: string;
    }[];
  }[];
}

/**
 * Req 12's first read — the roles on this install.
 *
 * Built from the same `buildRoleSettings` projection the Settings screen renders,
 * so the agent and the user are told the same thing by construction. A second
 * projection here is how the two would come to disagree about which roles exist.
 */
export function listRolesForAgent(deps: RoleDeps): AgentRoleListing[] {
  return buildRoleSettings(deps).map((role) => ({
    name: role.name,
    ...(role.description ? { description: role.description } : {}),
    ...(role.resolved
      ? {
          runsOn: [
            role.resolved.harnessName,
            role.resolved.label,
            role.resolved.reasoningLabel ?? role.resolved.reasoningEffort,
          ].join(" · "),
        }
      : {}),
    ...(role.unavailableReason ? { unavailable: role.unavailableReason } : {}),
  }));
}

/**
 * Req 12's second read — the parameters an override may name.
 *
 * `eligibleModels` is the registry's credential-filtered join (docs/252 req 8):
 * the models this harness can actually run *here*, rather than the catalogue's
 * full set. That is deliberately the narrower answer — a model the install has no
 * credential for is not a parameter an override may name, and offering it would
 * hand the agent a value the validator then refuses.
 *
 * Harnesses this deployment did not install are omitted for the same reason.
 * `isHarnessInstalled` asks the DECLARED install set rather than the registry's
 * `installed` probe, matching every other spawn-adjacent gate: a `which` miss in
 * a report-less environment is not the deployment saying no.
 */
export function listSpawnParameters(agentRegistry: AgentRegistry): SpawnParameterInventory {
  return {
    harnesses: agentRegistry
      .list()
      .filter((harness) => isHarnessInstalled(harness.id))
      .map((harness) => ({
        id: harness.id,
        name: harness.name,
        reasoningLevels: (harness.capabilities.reasoning?.options ?? []).map((o) => o.value),
        models: harness.eligibleModels.map((model) => ({
          serviceId: model.serviceId,
          billingMode: model.billingMode,
          modelId: model.modelId,
          label: model.label,
        })),
      })),
  };
}
