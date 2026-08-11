/**
 * docs/261 phase 2 (reqs 6, 7) — **what a one-shot spawn runs on**.
 *
 * `shipit agent run` answers that question in exactly two ways, and the
 * asymmetry between them is the feature rather than an inconsistency:
 *
 *  - a **role** (`--role reviewer`) names what it wants done and lets ShipIt
 *    resolve who does it, from settings the user owns (req 6);
 *  - an **explicit** call names everything — harness, service, billing mode,
 *    model and reasoning level — and an omission is **refused** rather than
 *    completed from a stored default the caller cannot see (req 7).
 *
 * That refusal is what let `SubAgentDefaults` be deleted rather than re-keyed:
 * with nothing filling a blank, there is no stored per-harness default left for
 * anything to read. A third path exists and is deliberately governed by neither
 * rule — a **child session** inherits from its parent (req 10) — because a child
 * session *has* a parent to inherit from and a one-shot run has nothing but its
 * own arguments.
 *
 * Two functions, split where the information arrives:
 *
 *  - {@link parseSubAgentSpawnTarget} runs at the HTTP edge on an untyped body.
 *    It is the authority, not the shim: the shim's own check buys a better
 *    message, never a guarantee.
 *  - {@link resolveSubAgentSpawnTarget} turns the target into the harness,
 *    selection and effort the spawn runs with. For a role that includes
 *    **routing** it, because req 8's answer is resolved at read time and "read
 *    time" needs a boundary: the target is captured ONCE here, at spawn
 *    admission, and is what retries, attribution and the transcript card all
 *    read afterwards. Recomputing it during a retry is how a review ends up
 *    attributed to a model that did not run it.
 */

import type {
  AgentId,
  ReviewerSlot,
  SubAgentRole,
  SubAgentSpawnTarget,
} from "../../shared/types.js";
import { SUB_AGENT_ROLES } from "../../shared/types.js";
import type { BillingMode, ModelSelection } from "../../shared/catalogue/types.js";
import { getHarness, getModel, selectionExists } from "../../shared/catalogue/index.js";
import type { ProviderRoute } from "../provider-account-manager.js";
import {
  selectReviewer,
  type ReviewerModelDeps,
  type ReviewerSource,
  type ReviewerTier,
} from "../reviewer-model.js";
import { selectionOf } from "../turn-attribution.js";
import { ServiceError } from "./types.js";

/** The wire shape of a spawn request's target half, before anything is checked. */
export interface SubAgentSpawnTargetBody {
  role?: unknown;
  agentId?: unknown;
  serviceId?: unknown;
  billingMode?: unknown;
  modelId?: unknown;
  reasoningEffort?: unknown;
}

/** The five fields that together name an explicit run, with the flag that sets each. */
const EXPLICIT_FIELDS = [
  { field: "agentId", flag: "--agent" },
  { field: "serviceId", flag: "--service" },
  { field: "billingMode", flag: "--billing-mode" },
  { field: "modelId", flag: "--model" },
  { field: "reasoningEffort", flag: "--effort" },
] as const;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Read a spawn request's target, refusing everything in between (req 7).
 *
 * Three refusals, each a different way of asking two questions at once:
 * a role **and** an explicit parameter; an unknown role; and an explicit call
 * missing any of its five. The last is the one the design exists for — a
 * half-specified call that gets silently filled in is precisely the failure mode
 * `SubAgentDefaults` was.
 */
export function parseSubAgentSpawnTarget(body: SubAgentSpawnTargetBody): SubAgentSpawnTarget {
  const role = str(body.role);
  const named = EXPLICIT_FIELDS.filter((f) => body[f.field] !== undefined);

  if (role !== undefined) {
    if (named.length > 0) {
      throw new ServiceError(
        400,
        `A role cannot be combined with ${named.map((f) => f.flag).join(", ")}. `
          + "--role asks ShipIt for the configured reviewer; the explicit flags name one yourself.",
      );
    }
    if (!(SUB_AGENT_ROLES as readonly string[]).includes(role)) {
      throw new ServiceError(
        400,
        `Unknown role "${role}". Known roles: ${SUB_AGENT_ROLES.join(", ")}.`,
      );
    }
    return { kind: "role", role: role as SubAgentRole };
  }

  const missing = EXPLICIT_FIELDS.filter((f) => str(body[f.field]) === undefined);
  if (missing.length > 0) {
    throw new ServiceError(
      400,
      "A run that names no role must name every parameter it runs on — missing "
        + `${missing.map((f) => f.flag).join(", ")}. Nothing is filled in from a stored setting. `
        + "Use --role reviewer to have ShipIt choose the reviewer instead.",
    );
  }
  const billingMode = str(body.billingMode);
  if (billingMode !== "sub" && billingMode !== "key") {
    throw new ServiceError(
      400,
      `--billing-mode must be "sub" or "key", not "${String(body.billingMode)}".`,
    );
  }
  // Non-null: the `missing` check above proved each of these is a non-blank
  // string, which is the only thing `str` can return besides `undefined`.
  return {
    kind: "explicit",
    subAgentId: str(body.agentId) as AgentId,
    serviceId: str(body.serviceId)!,
    billingMode,
    modelId: str(body.modelId)!,
    reasoningEffort: str(body.reasoningEffort)!,
  };
}

/**
 * What the spawn runs on, captured once at admission.
 *
 * `route` is set only for a role, whose reviewer was resolved **and routed** by
 * `selectReviewer`; an explicit run resolves its own route further down
 * `runSubAgent`, where the existing gates and the account-failover loop live.
 */
export interface ResolvedSpawnTarget {
  harnessId: AgentId;
  selection: ModelSelection;
  /** Never absent (req 5): a role carries the reviewer's level, an explicit call its own. */
  reasoningEffort: string;
  route?: ProviderRoute;
  /** Set for a role, for the log line and (phase 4) the consult card's attribution. */
  reviewer?: {
    slot: ReviewerSlot;
    source: ReviewerSource;
    tier: ReviewerTier;
    tierBasis: "model-and-harness" | "harness-only";
  };
}

/**
 * The session whose agent is asking — the *implementer* the reviewer is ranked
 * against (req 4).
 *
 * `agentId` is REQUIRED, and that is deliberate: a reviewer's distance is
 * measured from what the caller is running, so a default here would rank against
 * a harness nobody is using. `runSubAgent` proves it by refusing an unpinned
 * session before it gets this far. The model half stays optional — a session
 * with no selection makes the model axes undecidable, which the ranking handles
 * by collapsing onto the harness axis and saying so through `tierBasis`.
 */
export interface ImplementerSession {
  agentId: AgentId;
  model?: string;
  serviceId?: string;
  billingMode?: BillingMode;
}

export type ResolveSpawnTargetDeps = ReviewerModelDeps;

/**
 * Turn a parsed target into the harness, model and effort a spawn runs with.
 *
 * For a **role**, the reviewer is ranked against what the *implementer* is
 * running (req 4) and the winner is frozen here. The implementer's selection is
 * read from the session row, which is the best capture available at this point:
 * a retirement migrates the row and an account failover changes the credential
 * rather than the model, so the row and what is running agree on the axes the
 * ranking uses (family and canonical model).
 *
 * For an **explicit** call, the triple must name a real catalogue row and the
 * effort must be a level the named harness declares. Both are refusals rather
 * than corrections, for req 7's reason: a value quietly replaced by a working
 * one is the same failure as a value quietly supplied.
 */
export function resolveSubAgentSpawnTarget(
  target: SubAgentSpawnTarget,
  session: ImplementerSession,
  deps: ResolveSpawnTargetDeps,
): ResolvedSpawnTarget {
  if (target.kind === "explicit") {
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
    const options = getHarness(target.subAgentId)?.capabilities.reasoning?.options ?? [];
    if (options.length > 0 && !options.some((o) => o.value === target.reasoningEffort)) {
      throw new ServiceError(
        400,
        `Invalid --effort "${target.reasoningEffort}" for ${target.subAgentId}. `
          + `Valid levels: ${options.map((o) => o.value).join(", ")}.`,
      );
    }
    return {
      harnessId: target.subAgentId,
      selection,
      reasoningEffort: target.reasoningEffort,
    };
  }

  const chosen = selectReviewer(
    { harnessId: session.agentId, selection: selectionOf(session) },
    deps,
  );
  if (!chosen.ok) {
    throw new ServiceError(
      400,
      "No reviewer is available: neither configured reviewer has a credential that can run "
        + "right now. Connect a service in Settings, or wait for the quota to reset.",
    );
  }
  return {
    harnessId: chosen.target.harnessId,
    selection: chosen.target.selection,
    reasoningEffort: chosen.target.reasoningEffort,
    route: chosen.target.route,
    reviewer: {
      slot: chosen.target.slot,
      source: chosen.target.source,
      tier: chosen.tier,
      tierBasis: chosen.tierBasis,
    },
  };
}

/**
 * Refuse an explicit selection the named harness cannot run (req 7's other half:
 * the call is taken literally, so a harness pointed at another vendor's model is
 * an error rather than something to reroute).
 *
 * Checked against the registry's ELIGIBLE set, which is the same authority the
 * settings layer uses. An **empty** set means no credential source is wired (a
 * test registry, a bare runtime), not "nothing is eligible" — so it is skipped
 * rather than refusing everything, and the credential-route check downstream
 * stays the authority in that case.
 */
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
