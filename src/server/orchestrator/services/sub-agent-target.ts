/**
 * docs/261 phase 2 (reqs 6, 7) — **what a one-shot spawn runs on**.
 *
 * `shipit agent run` answers that question in exactly two ways, and the
 * asymmetry between them is the feature rather than an inconsistency:
 *
 *  - a **role** (`--role reviewer`) names what it wants done and lets ShipIt
 *    resolve who does it, from settings the user owns (req 6);
 *  - a **role plus overrides** (`--role reviewer --model NAME --effort LEVEL`)
 *    passes through a model name and/or reasoning level the USER named in chat
 *    (docs/263 req 1); ShipIt resolves the model's service and billing mode and
 *    the harness (req 3), so the caller never guesses a value it was not handed;
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
import type { ModelSelection } from "../../shared/catalogue/types.js";
import { getHarness, getModel, selectionExists } from "../../shared/catalogue/index.js";
import type { ProviderRoute } from "../provider-account-manager.js";
import {
  resolveReviewerByName,
  selectReviewer,
  type ImplementerContext,
  type NamedReviewerResult,
  type ReviewerModelDeps,
  type ReviewerSource,
  type ReviewerTier,
} from "../reviewer-model.js";
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
 * docs/263 — the two fields a role may carry, the per-review overrides. The
 * other three (harness, service, billing mode) are resolved by ShipIt and are
 * refused alongside a role rather than silently derived.
 */
const ROLE_OVERRIDE_FIELDS = new Set(["modelId", "reasoningEffort"]);

/**
 * Read a spawn request's target, refusing everything in between (req 7).
 *
 * The refusals, each a different way of asking two questions at once: a role
 * **and** one of the three non-override parameters; an unknown role; and an
 * explicit call missing any of its five. The last is the one the design exists
 * for — a half-specified call that gets silently filled in is precisely the
 * failure mode `SubAgentDefaults` was. A role **and** `modelId`/`reasoningEffort`
 * is not refused: that is docs/263's per-review override, where the caller
 * passes through a model name and/or level the USER named (req 1).
 */
export function parseSubAgentSpawnTarget(body: SubAgentSpawnTargetBody): SubAgentSpawnTarget {
  const role = str(body.role);

  if (role !== undefined) {
    const forbidden = EXPLICIT_FIELDS.filter(
      (f) => !ROLE_OVERRIDE_FIELDS.has(f.field) && body[f.field] !== undefined,
    );
    if (forbidden.length > 0) {
      throw new ServiceError(
        400,
        `A role cannot be combined with ${forbidden.map((f) => f.flag).join(", ")}. `
          + "The harness, service and billing mode are resolved by ShipIt; you may name a model "
          + "(--model) and/or a reasoning level (--effort) alongside --role reviewer.",
      );
    }
    if (!(SUB_AGENT_ROLES as readonly string[]).includes(role)) {
      throw new ServiceError(
        400,
        `Unknown role "${role}". Known roles: ${SUB_AGENT_ROLES.join(", ")}.`,
      );
    }
    // A blank override is a named value that cannot run — not an absence.
    // Absence means "ShipIt resolves it"; a blank `--effort ""` means "a value
    // was named but is empty", which must refuse rather than silently run the
    // reviewer's default (req 2).
    for (const [field, flag] of [
      ["modelId", "--model"],
      ["reasoningEffort", "--effort"],
    ] as const) {
      if (body[field] !== undefined && str(body[field]) === undefined) {
        throw new ServiceError(
          400,
          `--role reviewer: ${flag} was supplied as a blank value. Name a value, `
            + `or omit ${flag} to have ShipIt resolve it.`,
        );
      }
    }
    const modelName = str(body.modelId);
    const reasoningEffort = str(body.reasoningEffort);
    return {
      kind: "role",
      role: role as SubAgentRole,
      ...(modelName ? { modelName } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    };
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
  /**
   * Set for a bare role — the ranking's own account of itself, for the log
   * line. A named reviewer (docs/263) belongs to no slot, so `reviewer` is
   * absent on that path.
   *
   * Deliberately NOT on the consult card. Phase 4 persists what the consult RAN
   * ON (`SubAgentConsultCard.runOn`: service, mode, model, effort, beside the
   * harness), which is req 9's attribution; which slot won and by which rung is
   * ShipIt's internal reasoning about that choice, and rendering "reviewer 2 ·
   * tier 3" in the transcript would ask the user to hold a ranking in their head
   * to read a card. Settings is where the reviewers explain themselves (phase 3).
   */
  reviewer?: {
    /** Absent only for a named reviewer, which belongs to no slot (docs/263). */
    slot?: ReviewerSlot;
    source: ReviewerSource;
    tier: ReviewerTier;
    tierBasis: "model-and-harness" | "harness-only";
  };
}

export type ResolveSpawnTargetDeps = ReviewerModelDeps;

/**
 * Turn a parsed target into the harness, model and effort a spawn runs with.
 *
 * For a **role**, the reviewer is ranked against what the *implementer* is
 * running (req 4) and the winner is frozen here. `implementer` is the CALLER's
 * responsibility to capture, and `runSubAgent` takes it from the resident
 * process's spawn stamp rather than the mutable session row — see the comment at
 * that call site for why the difference is not cosmetic. `harnessId` is required
 * because a default would rank against a harness nobody is using; the selection
 * is optional, and its absence makes the model axes undecidable, which the
 * ranking reports through `tierBasis` rather than guessing.
 *
 * For an **explicit** call, the triple must name a real catalogue row and the
 * effort must be a level the named harness declares. Both are refusals rather
 * than corrections, for req 7's reason: a value quietly replaced by a working
 * one is the same failure as a value quietly supplied.
 */
export function resolveSubAgentSpawnTarget(
  target: SubAgentSpawnTarget,
  implementer: ImplementerContext,
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
    assertValidEffort(target.subAgentId, target.reasoningEffort);
    return {
      harnessId: target.subAgentId,
      selection,
      reasoningEffort: target.reasoningEffort,
    };
  }

  // docs/263 reqs 1–3 — a user-named model and/or effort rides the role. A
  // named model is resolved against the catalogue and this install (who pays is
  // derived, req 3); the bare role resolves the configured reviewer as before.
  // Either way the effort override is validated against the FINAL harness — the
  // one place a level can be checked, after the harness is known.
  const effortOverride = target.reasoningEffort;

  if (target.modelName) {
    const named = resolveReviewerByName(target.modelName, implementer, deps);
    if (!named.ok) throw new ServiceError(400, namedReviewerMessage(named, target.modelName));
    const base = named.target;
    return {
      harnessId: base.harnessId,
      selection: base.selection,
      reasoningEffort: applyEffortOverride(base.harnessId, effortOverride, base.reasoningEffort),
      route: base.route,
    };
  }

  const chosen = selectReviewer(implementer, deps);
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
    reasoningEffort: applyEffortOverride(
      chosen.target.harnessId,
      effortOverride,
      chosen.target.reasoningEffort,
    ),
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
 * Req 7's effort check, in one place — docs/261's rule that an unrecognized
 * level is refused rather than passed through, shared by the explicit call and
 * docs/263's per-review override (where the level must be valid for the harness
 * the model actually resolved to).
 */
function assertValidEffort(harnessId: AgentId, effort: string): void {
  const options = getHarness(harnessId)?.capabilities.reasoning?.options ?? [];
  if (options.length > 0 && !options.some((o) => o.value === effort)) {
    throw new ServiceError(
      400,
      `Invalid --effort "${effort}" for ${harnessId}. `
        + `Valid levels: ${options.map((o) => o.value).join(", ")}.`,
    );
  }
}

/** docs/263 — apply a named effort override onto a resolved reviewer's level. */
function applyEffortOverride(
  harnessId: AgentId,
  override: string | undefined,
  fallback: string,
): string {
  if (override === undefined) return fallback;
  assertValidEffort(harnessId, override);
  return override;
}

/** Turn a named-reviewer refusal into the message the caller meets (req 3). */
function namedReviewerMessage(
  result: Extract<NamedReviewerResult, { ok: false }>,
  modelName: string,
): string {
  switch (result.reason) {
    case "unknown_model":
      return `No model matches "${modelName}". Available model labels: ${result.candidates.join(", ")}. `
        + "Name one exactly, or use --role reviewer alone to have ShipIt choose.";
    case "ambiguous_model":
      return `"${modelName}" matches more than one model: ${result.candidates.join(", ")}. `
        + "Name one exactly.";
    case "no_route":
      return `No service on this install can run ${result.candidates[0]} right now. `
        + "Connect a service that offers it in Settings, or use --role reviewer alone.";
  }
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
