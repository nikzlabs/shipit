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
 *
 * **The handler is not session-credential-scoped.** `GET /api/sessions/:id/agent/params`
 * 404s if the session does not exist, then returns {@link listSpawnParameters}
 * with no session argument. `eligibleModels` is the process-wide cache, filled
 * from `listConfiguredCredentials(credentialStore)` at `detect()` /
 * `refreshAuth()` — the install store, including account rows, not the
 * calling worker's mount (docs/138).
 *
 * Whether every worker *observes* the same listing is a separate, disputed
 * fact: a grok-pinned session and a claude-pinned sibling measured disagreeing
 * `grep xai` output at the same instant (planning#452). Do not cite this
 * function as proof that an ordinary session can name a grok subscription
 * target.
 */

import type { AgentId, RoleView } from "../../shared/types.js";
import type { AgentInfo, AgentRegistry } from "../../shared/agent-registry.js";
import type { BillingMode } from "../../shared/catalogue/index.js";
import { reasoningOptionsFor } from "../../shared/catalogue/index.js";
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
            // Both absent ⇒ the role is at **Default** (docs/264 req 1): it runs
            // at whatever level its harness runs at with no flag. Named rather
            // than dropped — the agent reads this to decide whether it needs an
            // override at all, and a missing segment reads as "unknown".
            role.resolved.reasoningLabel ?? role.resolved.reasoningEffort ?? "Default",
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
/**
 * The levels this harness declares that at least one of its credentialed rows
 * honours, in the harness's own declared order (docs/274 req 14).
 *
 * Empty when the harness has no eligible rows at all — there is then nothing to
 * complete against, which is the honest answer rather than the vocabulary.
 */
function honouredLevels(harness: AgentInfo): string[] {
  const vocabulary = harness.capabilities.reasoning?.options ?? [];
  if (vocabulary.length === 0) return [];
  const honoured = new Set(
    harness.eligibleModels.flatMap((model) =>
      reasoningOptionsFor(harness.id, {
        serviceId: model.serviceId,
        billingMode: model.billingMode,
        modelId: model.modelId,
      }).map((option) => option.value),
    ),
  );
  return vocabulary.map((option) => option.value).filter((value) => honoured.has(value));
}

export function listSpawnParameters(agentRegistry: AgentRegistry): SpawnParameterInventory {
  return {
    harnesses: agentRegistry
      .list()
      .filter((harness) => isHarnessInstalled(harness.id))
      .map((harness) => ({
        id: harness.id,
        name: harness.name,
        // docs/274 req 14 — the harness's own vocabulary, NARROWED to the levels
        // at least one of its credentialed rows actually honours.
        //
        // The list drives tab completion for `--effort`, and
        // `parseSubAgentSpawnTarget` refuses a level the named selection does
        // not honour — so offering the bare vocabulary would complete a flag the
        // run then rejects. A union across rows rather than a per-row list,
        // because completion happens before a model is named.
        //
        // Narrowed rather than replaced: the vocabulary and its ORDER come from
        // the registry the caller injected, which stays authoritative about what
        // this harness declares; the catalogue only says which of those a row
        // sends.
        reasoningLevels: honouredLevels(harness),
        models: harness.eligibleModels.map((model) => ({
          serviceId: model.serviceId,
          billingMode: model.billingMode,
          modelId: model.modelId,
          label: model.label,
        })),
      })),
  };
}
