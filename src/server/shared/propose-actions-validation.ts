import type { ActionChecklistItem } from "./types.js";

export const MAX_ACTIONS = 5;
export const MIN_ACTIONS = 1;
export const MAX_ID_LEN = 64;
export const MAX_LABEL_LEN = 120;
export const MAX_DESC_LEN = 280;
export const MAX_PAYLOAD_LEN = 4000;
export const MAX_TITLE_LEN = 120;

// JSON Schema maxLength counts code points, not UTF-16 units.
function charLength(s: string): number {
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

function overLength(index: number, field: string, actual: number, cap: number): string {
  const repair =
    field === "payload"
      ? " Rewrite it as a compact standalone instruction — name the files, docs or issue to read instead of pasting their content — and call propose_actions again."
      : " Shorten it and call propose_actions again.";
  return `actions[${index}].${field} is ${actual} chars; the cap is ${cap}.${repair}`;
}
