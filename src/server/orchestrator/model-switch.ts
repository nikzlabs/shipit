/**
 * docs/252 phase 4 (req 4) — **the picker acting on a live session.**
 *
 * The mechanism a mid-session switch rides on is phase 3's and is not here: the
 * resident process's identity is the whole spawn-relevant tuple
 * (`service-routing.ts`), the guard that respawns on a change is
 * `resident-spawn-guard.ts`, and the pinned credential route is invalidated on a
 * `(service, mode)` move by `sessions.setModelSelection`. What is here is the
 * *interaction* on top of them: what a `set_model` / `set_agent` from the picker
 * is allowed to do to a live session, and what the user is told about it.
 *
 * Two rules, and both exist because a model id stopped being a global
 * identifier (req 5).
 *
 * ## 1. An explicit triple is honoured or refused — never re-resolved
 *
 * Phase 3 accepted a triple only when it named a real, eligible catalogue row
 * and otherwise **fell through to bare-id resolution**. That fallback is
 * correct for a client that sent no triple at all (an older browser, Quick
 * Capture) and wrong for one that sent a triple ShipIt would not honour: the
 * bare id is re-resolved, biased toward the harness's own vendor, and lands on
 * *whichever service sorts first among those offering it*. Concretely — pick
 * `anthropic/claude-opus-5` on Vercel with no Vercel key, and the session
 * silently moves to OpenRouter and bills it. The user asked for one service and
 * got another, which is exactly the mis-billing req 11 exists to prevent, and
 * phase 4 is the phase that makes picking a second service routine.
 *
 * So a triple that the catalogue does not carry, or that this harness cannot
 * run on this install (req 8), is **refused**. Refusing is safe because the
 * picker only ever offers eligible rows: reaching this means the client's list
 * is stale (a credential removed in another tab), and the honest answer to a
 * stale list is to say so rather than to pick something else on the user's
 * behalf.
 *
 * ## 2. A harness switch conforms the whole triple, not a bare id
 *
 * `set_agent` used to keep the session's model whenever the new harness's model
 * id list contained the id. That list is credential-narrowed, so this is not
 * about eligibility — it is that an id does not say which `(service, mode)` the
 * session is on. Two harnesses can both offer `anthropic/claude-opus-5` while
 * only one of them reaches it through the service the session is pinned to, and
 * the id-only test kept that pinning silently. The test is now the triple
 * against the new harness's eligible set, which is the same question the picker
 * asks.
 *
 * ## Saying so
 *
 * A harness switch can move three things the user did not pick — the model, the
 * `(service, billing mode)` it is billed to, and the reasoning effort (whose
 * levels belong to the harness, so a value one CLI accepts need not exist on the
 * other). They are computed in different places and used to be reported in
 * none. {@link describeSelectionMove} renders all of them as **one** sentence,
 * so the composer reports a switch's consequences once rather than leaving the
 * user to notice a changed dropdown.
 */

import type { AgentInfo, EligibleModel } from "../shared/agent-registry.js";
import type { BillingMode, ModelSelection } from "../shared/catalogue/index.js";
import { selectionExists } from "../shared/catalogue/index.js";

/** The session fields these rules read. */
export interface SelectionSource {
  model?: string;
  serviceId?: string;
  billingMode?: BillingMode;
}

/** The session's persisted triple, when it holds a complete one. */
export function selectionFrom(session: SelectionSource | undefined): ModelSelection | undefined {
  if (!session?.model || !session.serviceId || !session.billingMode) return undefined;
  return {
    serviceId: session.serviceId,
    billingMode: session.billingMode,
    modelId: session.model,
  };
}

/** Is this exact triple one `agent` can run on this install (req 8)? */
export function isEligibleOnAgent(
  agent: Pick<AgentInfo, "eligibleModels"> | undefined,
  selection: ModelSelection | undefined,
): boolean {
  if (!agent || !selection) return false;
  return agent.eligibleModels.some(
    (m) =>
      m.serviceId === selection.serviceId
      && m.billingMode === selection.billingMode
      && m.modelId === selection.modelId,
  );
}

/** An eligible entry as a bare selection triple. */
export function selectionOfEntry(entry: EligibleModel): ModelSelection {
  return {
    serviceId: entry.serviceId,
    billingMode: entry.billingMode,
    modelId: entry.modelId,
  };
}

/** Same service, same mode, same model. */
export function sameSelectionTriple(
  a: ModelSelection | undefined,
  b: ModelSelection | undefined,
): boolean {
  if (!a || !b) return a === b;
  return (
    a.serviceId === b.serviceId && a.billingMode === b.billingMode && a.modelId === b.modelId
  );
}

// ---- Rule 1: an explicit triple from the picker --------------------------

export type ExplicitSelectionVerdict =
  | { ok: true; selection: ModelSelection }
  | { ok: false; message: string };

/** A triple whose service or mode is missing — a request neither half can answer. */
const INCOHERENT = Symbol("incoherent-selection");

/**
 * What the client asked for: a full triple, `undefined` for "no triple sent", or
 * {@link INCOHERENT} for **exactly one** of the two fields.
 *
 * The three-way answer exists because the two-way one silently discards a half.
 * `serviceId` and `billingMode` are independently optional on the wire, and
 * reading "one missing" as "no triple" throws away the field that WAS sent and
 * re-resolves the bare id — so `{model: X, serviceId: "vercel"}` could persist X
 * on OpenRouter, which is the exact mis-billing the refusal rule exists to
 * prevent, arriving through a malformed request instead of a stale one. Only
 * "neither field" is the legacy shape.
 */
export function modelSelectionFrom(
  modelId: string,
  serviceId: string | undefined,
  billingMode: BillingMode | undefined,
): ModelSelection | typeof INCOHERENT | undefined {
  if (serviceId && billingMode) return { serviceId, billingMode, modelId };
  if (serviceId || billingMode) return INCOHERENT;
  return undefined;
}

/**
 * Whether a `(service, billing mode, model)` the client sent may be persisted.
 *
 * `undefined` means the client sent no triple, which is not an error — the
 * caller falls back to bare-id resolution, which is what an older browser and
 * Quick Capture still rely on.
 */
export function verifyExplicitSelection(
  agent: Pick<AgentInfo, "name" | "eligibleModels"> | undefined,
  selection: ModelSelection | typeof INCOHERENT | undefined,
): ExplicitSelectionVerdict | undefined {
  if (selection === undefined) return undefined;
  if (selection === INCOHERENT) {
    return {
      ok: false,
      message: "That model selection is incomplete — reload the page and pick again.",
    };
  }
  if (!selectionExists(selection)) {
    return {
      ok: false,
      message:
        `ShipIt has no "${selection.modelId}" on ${selection.serviceId}. `
        + "Reload the page — this list is out of date.",
    };
  }
  if (!isEligibleOnAgent(agent, selection)) {
    return {
      ok: false,
      message:
        `${selection.modelId} on ${selection.serviceId} has no credential `
        + `${agent?.name ?? "this harness"} can use. `
        + "Add one in Settings → Services, or pick another model.",
    };
  }
  return { ok: true, selection };
}

// ---- Rule 2: conforming a selection to a newly chosen harness -------------

/** What a harness switch moved that the user did not pick. */
export interface SelectionMove {
  /** The triple the session should now hold, or `undefined` to leave it alone. */
  selection?: ModelSelection;
  /** True when the model id itself changed. */
  modelMoved: boolean;
  /** True when the `(service, billing mode)` changed. */
  serviceMoved: boolean;
  /** True when the reasoning effort had to be dropped back to the CLI default. */
  reasoningCleared: boolean;
}

/**
 * The selection and reasoning a session should hold after switching to
 * `agent` — keeping both untouched where the new harness offers them, and
 * moving to its first eligible model where it does not.
 *
 * The model rule is the triple, not the id: keeping `(vercel, key, X)` because
 * the new harness's join happens to contain `X` leaves a session pointed at a
 * service that harness cannot authenticate with.
 *
 * The reasoning rule is deliberately different — **reset to the CLI default
 * rather than map to a neighbouring level**, because a level name two CLIs
 * share is not a promise of shared semantics, and omitting the flag is always
 * valid (`plan.md`, "Reasoning effort stays on the harness").
 */
export function conformSelectionToAgent(args: {
  agent: Pick<AgentInfo, "eligibleModels" | "capabilities">;
  /** The session's persisted triple, when it has one. */
  current: ModelSelection | undefined;
  /**
   * The bare id in force when there is no triple — the new-session composer,
   * which has no session row to read. The rule degrades to "does the new
   * harness offer this id at all", which is what it could always answer, rather
   * than rewriting a selection the composer never persisted.
   */
  currentModelId?: string | undefined;
  currentReasoning: string | undefined;
}): SelectionMove {
  const { agent, current, currentModelId, currentReasoning } = args;
  const reasoningCleared =
    !!currentReasoning
    && !agent.capabilities.reasoning?.options.some((o) => o.value === currentReasoning);
  const unchanged: SelectionMove = { modelMoved: false, serviceMoved: false, reasoningCleared };

  const keeps = current
    ? isEligibleOnAgent(agent, current)
    : currentModelId === undefined
      ? true
      : agent.eligibleModels.some((m) => m.modelId === currentModelId);
  if (keeps) return unchanged;
  const fallback = agent.eligibleModels[0];
  // Nothing eligible on the new harness. The caller's own auth gate refuses the
  // switch before reaching here, so this is the defensive branch: leave the
  // selection alone rather than clear it, since a cleared one is a session that
  // cannot say what it will run (req 11).
  if (!fallback) return unchanged;

  const selection = selectionOfEntry(fallback);
  return {
    selection,
    modelMoved: selection.modelId !== (current?.modelId ?? currentModelId),
    serviceMoved:
      !!current
      && (selection.serviceId !== current.serviceId
        || selection.billingMode !== current.billingMode),
    reasoningCleared,
  };
}

// ---- Saying so ------------------------------------------------------------

/** How a `(service, billing mode)` reads in a sentence. */
export function describeGroup(serviceName: string, billingMode: BillingMode): string {
  return `${serviceName} ${billingMode === "sub" ? "subscription" : "API key"}`;
}

/**
 * One sentence naming everything a switch moved, or `undefined` when it moved
 * nothing.
 *
 * One sentence rather than three messages: the three facts are computed in
 * different places and a user who reads only the last one is told the least
 * consequential of them.
 */
export function describeSelectionMove(args: {
  agentName: string;
  move: SelectionMove;
  /** The catalogue label + service name for the moved-to model, when it moved. */
  movedTo?: { label: string; serviceName: string; billingMode: BillingMode };
}): string | undefined {
  const { agentName, move, movedTo } = args;
  const parts: string[] = [];
  if ((move.modelMoved || move.serviceMoved) && movedTo) {
    parts.push(
      `moved to ${movedTo.label} on ${describeGroup(movedTo.serviceName, movedTo.billingMode)}`,
    );
  }
  if (move.reasoningCleared) parts.push("reset the reasoning effort to its default");
  if (parts.length === 0) return undefined;
  return `${agentName} ${parts.join(" and ")}.`;
}
