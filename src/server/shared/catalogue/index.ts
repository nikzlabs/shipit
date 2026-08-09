/**
 * docs/252 phase 1 — the derived view over the catalogue.
 *
 * Nothing here decides policy; it answers the questions the rest of the product
 * asks of the rows. The service×harness **join** lives here (an intersection of
 * style sets, per req 6), as does the resolution of a bare model id into the
 * `(serviceId, billingMode, modelId)` triple that replaces it.
 *
 * Phase 1 boundary, stated once so it is not mistaken for an oversight:
 * **eligibility is not here.** Whether a mode has a usable credential is req 8's
 * question and phase 3's code. Everything below is the catalogue's own view —
 * what exists, not what this install can run.
 */

import type { AgentId } from "../types/agent-types.js";
import { HARNESSES } from "./harnesses.js";
import { SERVICES, type ServiceId } from "./services.js";
import type {
  ApiStyle,
  BillingMode,
  BillingModeDef,
  HarnessDef,
  ModelDef,
  ModelSelection,
  ServiceDef,
} from "./types.js";

export * from "./types.js";
export { HARNESSES } from "./harnesses.js";
export { SERVICES, type ServiceId } from "./services.js";

/**
 * Compile-time proof that `ServiceId` really is the union of the shipped rows.
 * If a row's id changes and a consumer still names the old one, this stops being
 * assignable — which is the whole benefit of deriving the union from the data.
 */
const _SERVICE_IDS_ARE_LITERAL: readonly ServiceId[] = SERVICES.map((s) => s.id);
void _SERVICE_IDS_ARE_LITERAL;

/** Every service, in catalogue order. Order is load-bearing: it decides defaults. */
export function allServices(): readonly ServiceDef[] {
  return SERVICES;
}

/** Every harness ShipIt knows how to drive, in catalogue order. */
export function allHarnesses(): readonly HarnessDef[] {
  return HARNESSES;
}

export function getService(serviceId: string): ServiceDef | undefined {
  return SERVICES.find((s) => s.id === serviceId);
}

export function getHarness(harnessId: AgentId): HarnessDef | undefined {
  return HARNESSES.find((h) => h.id === harnessId);
}

/**
 * The service a harness's own vendor provides, when there is one. The bias a
 * caller holding only a model id should pass to {@link resolveModelSelection}:
 * before this feature a harness could reach nothing else, so a legacy id from a
 * `claude` session is an Anthropic id even though a gateway may list the same
 * string.
 */
export function nativeServiceForHarness(harnessId: AgentId | undefined): string | undefined {
  return harnessId ? getHarness(harnessId)?.nativeService : undefined;
}

export function getMode(serviceId: string, billingMode: BillingMode): BillingModeDef | undefined {
  return getService(serviceId)?.modes.find((m) => m.kind === billingMode);
}

/** The model a selection names, or `undefined` when the triple names no row. */
export function getModel(selection: ModelSelection): ModelDef | undefined {
  return getMode(selection.serviceId, selection.billingMode)?.models.find(
    (m) => m.id === selection.modelId,
  );
}

/** True when the catalogue contains the row this triple names. */
export function selectionExists(selection: ModelSelection): boolean {
  return getModel(selection) !== undefined;
}

/**
 * The API style a turn on this `(harness, model)` pair would use: **the first
 * entry of the harness's `styles` that the model also declares**.
 *
 * The harness's array is therefore ordered by preference, not incidentally.
 * Returns `undefined` when the sets do not intersect, which is exactly "this
 * harness cannot run this model" (req 6).
 *
 * Both shipped harnesses declare one style, so this is a no-op today. It exists
 * because the alternative — discovering the ambiguity in phase 3 with an
 * implementer picking arbitrarily — is how a silent per-turn inconsistency gets
 * built.
 */
export function resolveStyle(harnessId: AgentId, model: ModelDef): ApiStyle | undefined {
  const harness = getHarness(harnessId);
  if (!harness) return undefined;
  return harness.styles.find((style) => model.styles.includes(style));
}

/** The endpoint a turn on this selection and harness would be sent to. */
export function resolveEndpoint(harnessId: AgentId, selection: ModelSelection): string | undefined {
  const mode = getMode(selection.serviceId, selection.billingMode);
  const model = mode?.models.find((m) => m.id === selection.modelId);
  if (!mode || !model) return undefined;
  const style = resolveStyle(harnessId, model);
  return style ? mode.endpoints[style] : undefined;
}

/** A catalogue row paired with the identity that names it. */
export interface CatalogueEntry {
  selection: ModelSelection & { serviceId: ServiceId };
  service: ServiceDef;
  mode: BillingModeDef;
  model: ModelDef;
}

/**
 * Every `(service, mode, model)` the catalogue declares under a style
 * `harnessId` shares — the join, in catalogue order.
 *
 * This is the *catalogue's* answer, not the install's: it says nothing about
 * credentials (req 8) or about whether the harness is installed (req 14).
 * Phase 3 filters it; phase 1 only derives it.
 */
export function catalogueEntriesForHarness(harnessId: AgentId): CatalogueEntry[] {
  const out: CatalogueEntry[] = [];
  for (const service of SERVICES) {
    for (const mode of service.modes) {
      for (const model of mode.models) {
        if (resolveStyle(harnessId, model) === undefined) continue;
        out.push({
          selection: { serviceId: service.id, billingMode: mode.kind, modelId: model.id },
          service,
          mode,
          model,
        });
      }
    }
  }
  return out;
}

/**
 * The model ids a harness can offer **from its own vendor's service** only.
 *
 * This is the deliberate phase-1 narrowing, and the reason nothing user-visible
 * moves: today `AGENT_DEFS[].capabilities.models` is a hand-kept list of the
 * harness vendor's own models, so deriving it from the whole join would put
 * DeepSeek and the gateways into the picker before there is any way to give them
 * a credential (phase 2) or to route a turn to them (phase 3). Phase 3 replaces
 * this with the credential-filtered join and this function goes away.
 *
 * De-duplicated across billing modes, preserving first-seen order.
 */
export function nativeModelIdsForHarness(harnessId: AgentId): string[] {
  const harness = getHarness(harnessId);
  if (!harness?.nativeService) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of catalogueEntriesForHarness(harnessId)) {
    if (entry.service.id !== harness.nativeService) continue;
    if (seen.has(entry.model.id)) continue;
    seen.add(entry.model.id);
    out.push(entry.model.id);
  }
  return out;
}

/**
 * Every `(service, mode)` pair that declares this exact model id, in catalogue
 * order. The basis for resolving a stored bare id — and for the session
 * migration's "prefer `sub`, but only among the modes that actually offer this
 * model" rule.
 */
export function modesOfferingModel(modelId: string): { serviceId: ServiceId; billingMode: BillingMode }[] {
  const out: { serviceId: ServiceId; billingMode: BillingMode }[] = [];
  for (const service of SERVICES) {
    for (const mode of service.modes) {
      if (mode.models.some((m) => m.id === modelId)) {
        out.push({ serviceId: service.id, billingMode: mode.kind });
      }
    }
  }
  return out;
}

/**
 * Resolve a bare model id to a full selection, by the first-eligible rule: the
 * first service, then the first billing mode, that declares it.
 *
 * `preferredServiceId` biases the search without constraining it, which is what
 * lets a caller that knows the harness (and therefore its native service) keep
 * a legacy id on the vendor it plainly came from instead of on whichever
 * gateway happens to list the same string.
 *
 * Returns `undefined` for an id the catalogue does not carry at all — a real
 * case (a versioned id the picker never surfaced, or a model since retired), and
 * one every caller must handle rather than fabricate a triple for.
 */
export function resolveModelSelection(
  modelId: string | undefined,
  preferredServiceId?: string,
): ModelSelection | undefined {
  if (!modelId) return undefined;
  const candidates = modesOfferingModel(modelId);
  if (candidates.length === 0) return undefined;
  const preferred = preferredServiceId
    ? candidates.find((c) => c.serviceId === preferredServiceId)
    : undefined;
  const chosen = preferred ?? candidates[0];
  return { serviceId: chosen.serviceId, billingMode: chosen.billingMode, modelId };
}

/** Whether two selections name the same catalogue row. */
export function sameSelection(a: ModelSelection | undefined, b: ModelSelection | undefined): boolean {
  if (!a || !b) return a === b;
  return a.serviceId === b.serviceId && a.billingMode === b.billingMode && a.modelId === b.modelId;
}

/**
 * Whether two selections share a `(service, mode)` owner. This is the question
 * a persisted credential route has to answer: the route belongs to a
 * `(service, billing mode)`, so a selection change that crosses either must
 * invalidate it, while a plain model change within one mode must not.
 */
export function sameCredentialOwner(
  a: ModelSelection | undefined,
  b: ModelSelection | undefined,
): boolean {
  if (!a || !b) return a === b;
  return a.serviceId === b.serviceId && a.billingMode === b.billingMode;
}

/**
 * Display labels for every model id the catalogue carries, first-seen wins.
 * Absorbs what the client's hand-kept `MODEL_DISPLAY_NAMES` record held for
 * catalogue models; ids the catalogue does not carry (historical/versioned ones)
 * still need their own entries there.
 */
export function catalogueModelLabels(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const service of SERVICES) {
    for (const mode of service.modes) {
      for (const model of mode.models) {
        if (!(model.id in out)) out[model.id] = model.label;
      }
    }
  }
  return out;
}

/**
 * Context windows for every model id the catalogue carries, first-seen wins.
 * Absorbs what `MODEL_CONTEXT_WINDOWS` held for catalogue models.
 *
 * A `byHarness` override is deliberately NOT flattened here — this map is keyed
 * by model id alone, which is what the existing first-frame lookup takes. A
 * caller that knows the harness should use {@link contextWindowFor}.
 */
export function catalogueContextWindows(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const service of SERVICES) {
    for (const mode of service.modes) {
      for (const model of mode.models) {
        if (!(model.id in out)) out[model.id] = model.contextWindow.default;
      }
    }
  }
  return out;
}

/** The context window for a selection on a given harness, honouring `byHarness`. */
export function contextWindowFor(
  selection: ModelSelection,
  harnessId?: AgentId,
): number | undefined {
  const model = getModel(selection);
  if (!model) return undefined;
  const override = harnessId ? model.contextWindow.byHarness?.[harnessId] : undefined;
  return override ?? model.contextWindow.default;
}

// ---- Wire form -------------------------------------------------------------

/**
 * The selection as one string, for the few places that can only hold a scalar —
 * notably the browser's `vibe-model-id` slot, which seeds every new session.
 *
 * `service:mode:model` rather than JSON: a model id can contain `/`, `.`, `[`
 * and `]` (see `glm-5.2[1m]` and the gateways' `provider/model` ids) but never a
 * colon in any row the catalogue carries, and the parse splits on the FIRST TWO
 * colons only so a future id containing one still round-trips.
 */
export function serializeSelection(selection: ModelSelection): string {
  return `${selection.serviceId}:${selection.billingMode}:${selection.modelId}`;
}

/**
 * Parse {@link serializeSelection}'s form. Returns `undefined` for anything that
 * is not that form — including a **bare model id**, which is exactly what the
 * legacy value in storage is, so callers can tell "legacy, migrate it" from
 * "well-formed" rather than guessing.
 */
export function parseSelection(raw: string | undefined): ModelSelection | undefined {
  if (!raw) return undefined;
  const first = raw.indexOf(":");
  if (first <= 0) return undefined;
  const second = raw.indexOf(":", first + 1);
  if (second <= first + 1) return undefined;
  const serviceId = raw.slice(0, first);
  const billingMode = raw.slice(first + 1, second);
  const modelId = raw.slice(second + 1);
  if (billingMode !== "sub" && billingMode !== "key") return undefined;
  if (!modelId) return undefined;
  return { serviceId, billingMode, modelId };
}
