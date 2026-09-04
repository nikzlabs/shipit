/**
 * Shared validation for the `propose_actions` payload (docs/207 / planning#155).
 *
 * This lives in `shared/` because BOTH sides must reject identically: the
 * session-side MCP tool's fail-fast pre-check (`mcp-tools/propose-actions.ts`)
 * and the authoritative orchestrator route
 * (`orchestrator/api-routes-propose-actions.ts`). It used to live only in the
 * route, so the tool could pre-check nothing but "is `actions` a non-empty
 * array" — every other violation cost an HTTP round trip and, because the agent
 * is told to fire the card LAST, arrived after the closing prose was already
 * written.
 *
 * Every message is written to be MODEL-READABLE and self-correcting: it names
 * the offending index, the measured size, the cap, and what to do about it, so
 * the agent can repair the call in the same turn instead of dropping the card.
 */

import type { ActionChecklistItem } from "./types.js";

/** Validation bounds. These are also stated in the tool's JSON schema so the model can respect them up front. */
export const MAX_ACTIONS = 5;
export const MIN_ACTIONS = 1;
export const MAX_ID_LEN = 64;
export const MAX_LABEL_LEN = 120;
export const MAX_DESC_LEN = 280;
export const MAX_PAYLOAD_LEN = 4000;
export const MAX_TITLE_LEN = 120;

/**
 * Length in Unicode CODE POINTS, which is what JSON Schema's `maxLength`
 * counts. JavaScript's `String.length` counts UTF-16 code units, so it doubles
 * every astral character: 3000 emoji measure 6000 there and would be rejected
 * as "over 4000" while satisfying the very `maxLength` this module's caps are
 * advertised through. The whole point of the caps is that the model can see
 * them, so the two counts have to agree.
 */
function charLength(s: string): number {
  // Fast path: no surrogates ⇒ the two counts are identical. `Array.from`
  // iterates code points (not the spread form, which `no-misused-spread` flags).
  return /[\uD800-\uDBFF]/.test(s) ? Array.from(s).length : s.length;
}

interface RawAction {
  id?: unknown;
  label?: unknown;
  description?: unknown;
  defaultChecked?: unknown;
  payload?: unknown;
}

export interface ValidatedActions {
  title?: string;
  actions: ActionChecklistItem[];
}

/**
 * Validate + normalize a `propose_actions` payload. Returns `{ error }` with a
 * model-readable message on any violation so both the tool's fail-fast check and
 * the authoritative route reject identically. The order of `actions` is
 * preserved exactly (deterministic render order).
 */
export function validateProposeActions(body: {
  title?: unknown;
  actions?: unknown;
}): ValidatedActions | { error: string } {
  const rawActions = body.actions;
  if (!Array.isArray(rawActions) || rawActions.length < MIN_ACTIONS) {
    return { error: `\`actions\` must be a non-empty array (${MIN_ACTIONS}–${MAX_ACTIONS} items).` };
  }
  if (rawActions.length > MAX_ACTIONS) {
    return { error: `Too many actions (${rawActions.length}); cap is ${MAX_ACTIONS}. Propose the most relevant follow-ups only.` };
  }

  const seenIds = new Set<string>();
  const actions: ActionChecklistItem[] = [];
  for (let i = 0; i < rawActions.length; i++) {
    const a = rawActions[i] as RawAction;
    if (typeof a !== "object" || a === null) {
      return { error: `actions[${i}] must be an object with { id, label, payload }.` };
    }
    const id = typeof a.id === "string" ? a.id.trim() : "";
    const label = typeof a.label === "string" ? a.label.trim() : "";
    const payload = typeof a.payload === "string" ? a.payload.trim() : "";
    if (!id) return { error: `actions[${i}].id is required and must be a non-empty string.` };
    if (charLength(id) > MAX_ID_LEN) return { error: overLength(i, "id", charLength(id), MAX_ID_LEN) };
    if (seenIds.has(id)) return { error: `Duplicate action id "${id}" — ids must be unique within a card.` };
    seenIds.add(id);
    if (!label) return { error: `actions[${i}].label is required and must be a non-empty string.` };
    if (charLength(label) > MAX_LABEL_LEN) return { error: overLength(i, "label", charLength(label), MAX_LABEL_LEN) };
    if (!payload) return { error: `actions[${i}].payload is required and must be a non-empty string.` };
    if (charLength(payload) > MAX_PAYLOAD_LEN) return { error: overLength(i, "payload", charLength(payload), MAX_PAYLOAD_LEN) };
    const description = typeof a.description === "string" ? a.description.trim() : "";
    if (charLength(description) > MAX_DESC_LEN) return { error: overLength(i, "description", charLength(description), MAX_DESC_LEN) };

    const item: ActionChecklistItem = { id, label, payload };
    if (description) item.description = description;
    if (a.defaultChecked === true) item.defaultChecked = true;
    actions.push(item);
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (charLength(title) > MAX_TITLE_LEN) {
    return { error: `\`title\` is ${charLength(title)} chars; the cap is ${MAX_TITLE_LEN}. Shorten it and call propose_actions again.` };
  }

  return { ...(title ? { title } : {}), actions };
}

/**
 * A length error the model can act on: which field, how long it actually is,
 * the cap, and the repair. The `payload` case carries the extra hint because it
 * is the one that trips in practice — the instructions push for a "full,
 * self-contained instruction", which reads as "write everything down".
 */
function overLength(index: number, field: string, actual: number, cap: number): string {
  const repair =
    field === "payload"
      ? " Rewrite it as a compact standalone instruction — name the files, docs or issue to read instead of pasting their content — and call propose_actions again."
      : " Shorten it and call propose_actions again.";
  return `actions[${index}].${field} is ${actual} chars; the cap is ${cap}.${repair}`;
}
