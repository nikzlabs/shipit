import type { ActionChecklistItem } from "./types.js";

export const MAX_ACTIONS = 5;
export const MIN_ACTIONS = 1;
export const MAX_ID_LEN = 64;
export const MAX_LABEL_LEN = 120;
export const MAX_DESC_LEN = 280;
export const MAX_PAYLOAD_LEN = 4000;
export const MAX_TITLE_LEN = 120;

// JSON Schema maxLength counts code points, not UTF-16 units.
export function charLength(s: string): number {
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

/** Shared by `propose_actions` and `session_status`, which offer the same items. */
export interface ActionItemRules {
  /** Named in the repair sentences, so each tool tells the agent what to call again. */
  tool: string;
  min: number;
  /** Absent means no cap: the status card shows every offer the agent has (docs/303 req 18). */
  max?: number;
}

export function validateActionItems(
  rawActions: unknown,
  rules: ActionItemRules,
): { actions: ActionChecklistItem[] } | { error: string } {
  if (!Array.isArray(rawActions) || rawActions.length < rules.min) {
    return {
      error: rules.min > 0
        ? `\`actions\` must be a non-empty array (${rules.min}–${rules.max} items).`
        : "`actions` must be an array of action items.",
    };
  }
  if (rules.max !== undefined && rawActions.length > rules.max) {
    return { error: `Too many actions (${rawActions.length}); cap is ${rules.max}. Propose the most relevant follow-ups only.` };
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
    if (charLength(id) > MAX_ID_LEN) return { error: overLength(rules.tool, i, "id", charLength(id), MAX_ID_LEN) };
    if (seenIds.has(id)) return { error: `Duplicate action id "${id}" — ids must be unique within a card.` };
    seenIds.add(id);
    if (!label) return { error: `actions[${i}].label is required and must be a non-empty string.` };
    if (charLength(label) > MAX_LABEL_LEN) return { error: overLength(rules.tool, i, "label", charLength(label), MAX_LABEL_LEN) };
    if (!payload) return { error: `actions[${i}].payload is required and must be a non-empty string.` };
    if (charLength(payload) > MAX_PAYLOAD_LEN) return { error: overLength(rules.tool, i, "payload", charLength(payload), MAX_PAYLOAD_LEN) };
    const description = typeof a.description === "string" ? a.description.trim() : "";
    if (charLength(description) > MAX_DESC_LEN) return { error: overLength(rules.tool, i, "description", charLength(description), MAX_DESC_LEN) };

    const item: ActionChecklistItem = { id, label, payload };
    if (description) item.description = description;
    if (a.defaultChecked === true) item.defaultChecked = true;
    actions.push(item);
  }
  return { actions };
}

export function validateProposeActions(body: {
  title?: unknown;
  actions?: unknown;
}): ValidatedActions | { error: string } {
  const validated = validateActionItems(body.actions, {
    tool: "propose_actions",
    min: MIN_ACTIONS,
    max: MAX_ACTIONS,
  });
  if ("error" in validated) return validated;

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (charLength(title) > MAX_TITLE_LEN) {
    return { error: `\`title\` is ${charLength(title)} chars; the cap is ${MAX_TITLE_LEN}. Shorten it and call propose_actions again.` };
  }

  return { ...(title ? { title } : {}), actions: validated.actions };
}

function overLength(tool: string, index: number, field: string, actual: number, cap: number): string {
  const repair =
    field === "payload"
      ? ` Rewrite it as a compact standalone instruction — name the files, docs or issue to read instead of pasting their content — and call ${tool} again.`
      : ` Shorten it and call ${tool} again.`;
  return `actions[${index}].${field} is ${actual} chars; the cap is ${cap}.${repair}`;
}
