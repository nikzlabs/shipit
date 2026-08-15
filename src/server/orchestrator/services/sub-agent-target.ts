/**
 * docs/264 phase 3 (reqs 11, 16) — **what a spawn runs on**, for both spawn
 * commands.
 *
 * This module was docs/261's answer for `shipit agent run` alone. Req 16 makes
 * it the answer for `shipit session create` too: one parser, one validator, one
 * refusal rule, so the two commands are consistent *by construction* rather than
 * by two implementations agreeing.
 *
 * The shape is always **a base plus overrides**, and the three bases are the
 * three kinds of {@link SpawnTarget}:
 *
 *  - a **role** (`--role deep-dive`), available to both commands, completed from
 *    the role's own params — resolved, for the shipped reviewer (docs/264 req 2);
 *  - **nothing**, available to both, so the call must name all five itself. Kept
 *    implemented for a repository that holds a complete target of its own
 *    (req 15);
 *  - the **parent session**, available to `session create` only, because a
 *    one-shot run has no parent. That is the *only* difference between the two
 *    commands.
 *
 * **The surface is unified; the completion semantics are not.** A parent does
 * not complete a partial call the way a role does, and those differences are
 * docs/261's, deliberate and preserved — they live in `child-sessions.ts`, not
 * here. This module resolves the two bases that produce a *complete* tuple (a
 * role, or a five-parameter call) and hands the `inherit` case to the child path
 * untouched.
 *
 * **The refusal narrowed rather than disappearing.** `--role NAME` alongside a
 * parameter used to be refused and is now the override path (req 10). What stays
 * refused is a call with **no base and only some parameters** — the one shape
 * with nothing to complete it from. A partial call over a *parent* is not that
 * shape and must not be refused: it is the behaviour docs/261 req 10 guarantees.
 *
 * Two functions, split where the information arrives:
 *
 *  - {@link parseSpawnTarget} runs at the HTTP edge on an untyped body. It is
 *    the authority, not the shim: the shim's own check buys a better message,
 *    never a guarantee.
 *  - {@link resolveSpawnTarget} turns a role or an explicit target into the
 *    harness, selection and effort the spawn runs with. For a ranked reviewer
 *    that includes **routing** it, because docs/261 req 8's answer is resolved at
 *    read time and "read time" needs a boundary: the target is captured ONCE, at
 *    spawn admission, and is what retries, attribution and the transcript card
 *    all read afterwards. Recomputing it during a retry is how a review ends up
 *    attributed to a model that did not run it.
 *
 *    **That frozen route is for the one-shot path only.** A child session must
 *    NOT carry it — see {@link ResolvedSpawnTarget.route}.
 */

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
import { getHarness, getModel, resolveStyle, selectionExists } from "../../shared/catalogue/index.js";
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

/** The wire shape of a spawn request's target half, before anything is checked. */
export interface SubAgentSpawnTargetBody {
  role?: unknown;
  agentId?: unknown;
  serviceId?: unknown;
  billingMode?: unknown;
  modelId?: unknown;
  reasoningEffort?: unknown;
}

/** The five fields that together name a complete target, with the flag that sets each. */
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

/** `sub` / `key` or a refusal naming the flag. Shared by every path that reads one. */
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

/**
 * A parameter the caller **named**, or `undefined` when it named none.
 *
 * **A field that is present and unusable is refused, not treated as absent.**
 * That distinction is the difference between an override and a dropped override:
 * `--role reviewer --model "   "` used to have the blank value evaporate and the
 * *bare role* run instead, which is a run the caller never asked for — the exact
 * "a dropped override runs something other than what was asked for" failure
 * req 10 exists to prevent. Absent means "the base supplies it"; blank means the
 * caller tried to say something and it did not survive their shell.
 *
 * Cross-agent review found this.
 *
 * **JSON `null` is absence, deliberately, and it is the one exception.** The rule
 * above is about a value that *failed*: a flag whose shell expansion produced
 * nothing. A `null` cannot come from a shell — the CLI cannot spell one — so it
 * only ever arrives from a caller writing a body directly, where `null` is the
 * ordinary way JSON says "no value" (`{ modelId: user.model ?? null }`).
 * Refusing it would refuse the idiom rather than catching a mistake, so it reads
 * as "the base supplies it", exactly as an absent key does. Pinned by a test, so
 * the next reader sees a decision rather than an oversight.
 */
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

/**
 * The role name the caller named, **exactly as it typed it** (req 18).
 *
 * The one field here that is not normalized, and it must not be: a role name is
 * whatever the user typed, stored verbatim (`credential-store.ts`'s `setRole`
 * stores the key as given, deliberately) and resolved by **exact** key. Trimming
 * it here does not tidy a name — it names a *different role*: `" reviewer "` is
 * an ordinary role a user may create, distinct from the reserved one, and
 * trimming ran ShipIt's automatic reviewer instead of it; `" deep dive "` was
 * refused as unknown while existing. Every other field is a catalogue id, where
 * surrounding whitespace can never be part of the value, so {@link str} still
 * normalizes those.
 *
 * Blank is the one thing refused, on {@link readNamed}'s rule rather than a
 * second one: a name that is blank once whitespace is discounted cannot be
 * stored (`setRole` refuses it), so it can never be a role, and a caller that
 * passed `--role ""` tried to say something that did not survive its shell.
 */
function readRoleName(value: unknown): string | undefined {
  // Non-null: `readNamed` returns a string only where `value` was one.
  return readNamed(value, "--role") === undefined ? undefined : (value as string);
}

/** Whichever of the five the caller named, as overrides over whatever base it chose. */
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

/**
 * Read a spawn request's target — **one parser for both commands** (req 16).
 *
 * `parentBase` is the single axis on which they differ: `shipit session create`
 * has a parent to complete a partial call from, and `shipit agent run` does not.
 * Everything else — the role, the overrides, the validation — is identical, which
 * is what req 16 asks for.
 *
 * The refusals, in order:
 *
 *  1. a **role plus any subset of the parameters** is the override path (req 10),
 *     not an error. Only the billing mode is checked here, because it is the one
 *     field with a closed value set the shim can get wrong without the catalogue;
 *  2. a call with **no base and only some parameters** is refused, naming the
 *     flags it is missing. This is docs/261 req 7's rule, narrowed to its real
 *     target: nothing completes it, so filling the blanks would mean guessing;
 *  3. that refusal is **not** applied when a parent is available. A partial call
 *     over a parent is ordinary (req 16), and refusing it would delete the
 *     shipped behaviour docs/261 req 10 guarantees.
 */
export function parseSpawnTarget(
  body: SubAgentSpawnTargetBody,
  opts: { parentBase: boolean },
): SpawnTarget {
  const role = readRoleName(body.role);
  if (role !== undefined) {
    return { kind: "role", role, overrides: readOverrides(body) };
  }

  const missing = EXPLICIT_FIELDS.filter((f) => str(body[f.field]) === undefined);
  if (missing.length === 0) {
    // Non-null: `missing` being empty proved each is a non-blank string, which is
    // the only thing `str` can return besides `undefined`.
    return {
      kind: "explicit",
      harnessId: str(body.agentId) as AgentId,
      serviceId: str(body.serviceId)!,
      billingMode: readBillingMode(body.billingMode),
      modelId: str(body.modelId)!,
      reasoningEffort: str(body.reasoningEffort)!,
    };
  }
  if (opts.parentBase) {
    // The parent is the base. Partial is ordinary here — including the empty
    // call, which inherits everything, and the bare `--model X` docs/261 req 10
    // ships. How much of the parent each override carries is `child-sessions.ts`'s
    // question, deliberately NOT unified with a role's completion.
    return { kind: "inherit", overrides: readOverrides(body) };
  }
  throw new ServiceError(
    400,
    "A run that names no role must name every parameter it runs on — missing "
      + `${missing.map((f) => f.flag).join(", ")}. Nothing is filled in from a stored setting. `
      + `Use --role ${RESERVED_ROLE_NAME} (or any role you configured) to run one instead.`,
  );
}

/**
 * {@link parseSpawnTarget} for the one-shot path, which has no parent base.
 *
 * A thin alias, kept because the narrowed return type is what `runSubAgent`
 * needs: a one-shot run cannot inherit, and the type says so.
 */
export function parseSubAgentSpawnTarget(body: SubAgentSpawnTargetBody): SubAgentSpawnTarget {
  return parseSpawnTarget(body, { parentBase: false }) as SubAgentSpawnTarget;
}

/**
 * What the spawn runs on, captured once at admission.
 */
export interface ResolvedSpawnTarget {
  harnessId: AgentId;
  selection: ModelSelection;
  /** Never absent: a role carries its own level, an explicit call the one it named. */
  reasoningEffort: string;
  /**
   * The credential this run authenticates with, present only where a **ranked**
   * reviewer settled it and the caller did not move the tuple off it.
   *
   * **For the one-shot path only.** docs/261's rule is that a ranked reviewer
   * arrives already routed and the spawn must not re-ask, because re-asking
   * answers a settled question and could answer it differently *within* a single
   * run. A child session is not a single run: it lives for days and takes many
   * turns, so carrying this in would pin it to one credential for its whole life
   * and break account failover the first time that subscription is exhausted.
   * {@link resolveSpawnTargetForChild} drops it for exactly that reason
   * (docs/264 req 11 — a role decides what a child *starts as*, not what it is
   * bound to).
   */
  route?: ProviderRoute;
  /**
   * Set when the reviewer ranking ran — its own account of itself, for the log
   * line.
   *
   * Deliberately NOT on the consult card. docs/261 phase 4 persists what the
   * consult RAN ON (`SubAgentConsultCard.runOn`: service, mode, model, effort,
   * beside the harness), which is its attribution requirement; which slot won and
   * by which rung is ShipIt's internal reasoning about that choice, and rendering
   * "reviewer 2 · tier 3" in the transcript would ask the user to hold a ranking
   * in their head to read a card. Settings is where the reviewers explain
   * themselves.
   */
  reviewer?: {
    slot: ReviewerSlot;
    source: ReviewerSource;
    tier: ReviewerTier;
    tierBasis: "model-and-harness" | "harness-only";
  };
  /**
   * docs/264 req 14 — the role this target came from, when one did.
   *
   * A **snapshot of the name**, for attribution: the consult card reports it, and
   * a child session records it as `originRoleName`. It is not a live link — see
   * `sessions.ts`'s `setOriginRoleName`.
   */
  roleName?: string;
  /**
   * docs/264 req 8 — the role's standing instructions, when it carries any.
   *
   * Joined onto the run's own task by {@link joinRolePrompt}. Absent for an
   * explicit call and for a role without them.
   */
  rolePrompt?: string;
}

export type ResolveSpawnTargetDeps = RoleDeps & ReviewerModelDeps;

/**
 * Turn a parsed target into the harness, model and effort a spawn runs with.
 *
 * For a **role**, `services/roles.ts` owns the rules: a pinned role's tuple with
 * the caller's overrides substituted over it, or — for the shipped reviewer —
 * docs/261's ranking, unchanged when nothing was overridden. The ranking is
 * against what the *implementer* is running, and `implementer` is the CALLER's
 * responsibility to capture ({@link implementerFor} is the shared answer).
 *
 * For an **explicit** call, the triple must name a real catalogue row and the
 * effort must be a level the named harness declares. Both are refusals rather
 * than corrections, for docs/261 req 7's reason: a value quietly replaced by a
 * working one is the same failure as a value quietly supplied.
 *
 * `inherit` never reaches here — a parent base is completed by
 * `child-sessions.ts`, whose rules are deliberately not a role's.
 */
export function resolveSpawnTarget(
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
    // **Can this harness speak to this model at all?** A catalogue fact — one API
    // style in common — and the check that makes this function the single
    // validator req 16 claims. It used to live only on the one-shot path, in
    // `runSubAgent`'s `assertHarnessCanRunSelection`, so a child session naming a
    // complete target was accepted with an incoherent pair (`--agent claude
    // --model gpt-5.6-sol`), persisted, and left for turn-time routing to fail on.
    // Cross-agent review found that. Asked here, of the catalogue only: whether a
    // credential exists is a different question with a different remedy, and the
    // registry gate downstream still owns it.
    const model = getModel(selection);
    if (model && resolveStyle(target.harnessId, model) === undefined) {
      const harnessName = getHarness(target.harnessId)?.name ?? target.harnessId;
      throw new ServiceError(
        400,
        `${harnessName} cannot run ${model.label} — they share no API style.`,
      );
    }
    const options = getHarness(target.harnessId)?.capabilities.reasoning?.options ?? [];
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
      reasoningEffort: target.reasoningEffort,
    };
  }

  const resolved = resolveRoleByName(target.role, target.overrides, implementer, deps);
  return {
    harnessId: resolved.harnessId,
    selection: { ...resolved.selection },
    reasoningEffort: resolved.reasoningEffort,
    roleName: resolved.roleName,
    ...(resolved.prompt ? { rolePrompt: resolved.prompt } : {}),
    ...(resolved.route ? { route: { ...resolved.route } } : {}),
    ...(resolved.reviewer ? { reviewer: { ...resolved.reviewer } } : {}),
  };
}

/** docs/261's name for {@link resolveSpawnTarget}, kept for the one-shot call site. */
export const resolveSubAgentSpawnTarget = resolveSpawnTarget;

/**
 * {@link resolveSpawnTarget} for a **child session** — the same resolution with
 * the frozen route deliberately removed (docs/264 req 11).
 *
 * A one-shot run is admitted, routed and finished inside one request, so freezing
 * its credential is what keeps its attribution honest. A child session outlives
 * that by days: it takes turns of its own, each of which resolves its own route
 * through the ordinary session machinery, with account failover and
 * model-retirement behaviour intact. Handing it a route captured at creation
 * would pin it to one credential for its whole life, and the failure would not
 * appear until that subscription hit its quota — long after anyone would connect
 * the two. So the role decides what the child *starts as* and stops being
 * involved.
 *
 * `reviewer` goes with it: a ranking's account of a choice made once has nothing
 * to say about the child's later turns.
 */
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

/**
 * What a spawn's role resolution is ranked *against* — the session that is doing
 * the asking.
 *
 * Shared by both commands because both need the same answer and getting it wrong
 * is invisible: the implementer is what the session is **running**, not what its
 * row says. `runner.appliedSpawnIdentity` is the stamp taken when the resident
 * CLI was spawned and moves only on a respawn; the row is mutable under a running
 * turn (`set_model`). Ranking against the row lets this happen: a Claude harness
 * is producing work with DeepSeek, the user switches the picker to Opus, the
 * agent then asks for a review — and the ranking, comparing against Opus, hands
 * the work to DeepSeek, the exact thing that wrote it, which docs/261 req 4
 * forbids whenever an alternative is configured.
 *
 * The row stays the fallback for a session with no resident process (a fresh
 * runner, a local runtime, a test), where there is no capture to prefer.
 */
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
