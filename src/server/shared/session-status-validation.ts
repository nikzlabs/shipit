import type { ActionChecklistItem } from "./types.js";
import { charLength, validateActionItems } from "./propose-actions-validation.js";

/**
 * docs/303 req 2 — the concision is the length, not a count of offers.
 *
 * The status is markdown and may carry a short list (req 27), so its cap is
 * what a few bullets need rather than what one sentence needs. `needsYou` caps
 * each entry, and the list of them is the agent's to size.
 */
export const MAX_STATUS_LEN = 1200;
/**
 * req 31 — one or two sentences. Two sentences of ordinary prose run to roughly
 * 200–300 characters, so this leaves room without letting the line become a
 * second status.
 */
export const MAX_LAST_TURN_LEN = 400;
export const MAX_NEEDS_YOU_LEN = 240;
export const MAX_NEEDS_YOU_ITEMS = 10;

/**
 * One accepted `session_status` call, as a delta on the stored card.
 *
 * Every field is optional: an omitted one leaves the stored value alone, so a
 * call with nothing in it is the agent confirming the card still holds
 * (docs/303 req 14). `needsYou: []` is the one field that clears.
 */
export interface ValidatedSessionStatus {
  /**
   * The exception: `lastTurn` is NOT a delta. An accepted call that omits it
   * clears the stored line (req 31), so `undefined` here means "no line", not
   * "leave the stored one".
   */
  lastTurn?: string;
  status?: string;
  needsYou?: string[];
  actions?: ActionChecklistItem[];
  replaceActions?: boolean;
}

export function validateSessionStatus(
  body: {
    lastTurn?: unknown;
    status?: unknown;
    needsYou?: unknown;
    actions?: unknown;
    replaceActions?: unknown;
  },
  opts: { hasStoredCard: boolean },
): ValidatedSessionStatus | { error: string } {
  const call: ValidatedSessionStatus = {};

  if (body.lastTurn !== undefined) {
    if (typeof body.lastTurn !== "string") {
      return { error: "`lastTurn` must be a string." };
    }
    const lastTurn = body.lastTurn.trim();
    // An empty string is the same as omitting it: no line on the card. It is
    // not refused, because "" is the natural way to say "nothing worth saying".
    if (lastTurn) {
      if (charLength(lastTurn) > MAX_LAST_TURN_LEN) {
        return { error: overLength("lastTurn", charLength(lastTurn), MAX_LAST_TURN_LEN) };
      }
      call.lastTurn = lastTurn;
    }
  }

  if (body.status !== undefined) {
    if (typeof body.status !== "string") {
      return { error: "`status` must be a string." };
    }
    const status = body.status.trim();
    // There is no "clear the status": a card either says what the session is
    // about or does not exist. Omit the field to leave it as it stands.
    if (!status) return { error: "`status` must be a non-empty string; omit it to leave the stored status unchanged." };
    if (charLength(status) > MAX_STATUS_LEN) {
      return { error: overLength("status", charLength(status), MAX_STATUS_LEN) };
    }
    call.status = status;
  }

  if (body.needsYou !== undefined) {
    // req 27 — one entry per thing the user has to do, shown as a list.
    if (!Array.isArray(body.needsYou)) {
      return { error: "`needsYou` must be a list of strings, one per thing the user has to do; pass [] to clear it." };
    }
    if (body.needsYou.length > MAX_NEEDS_YOU_ITEMS) {
      return { error: `\`needsYou\` has ${body.needsYou.length} entries; the cap is ${MAX_NEEDS_YOU_ITEMS}.` };
    }
    const entries: string[] = [];
    for (const entry of body.needsYou) {
      if (typeof entry !== "string") {
        return { error: "Every `needsYou` entry must be a string." };
      }
      const trimmed = entry.trim();
      // An empty entry is a mistake, not a clear: [] is the clear.
      if (!trimmed) {
        return { error: "A `needsYou` entry cannot be empty; pass [] to clear the field." };
      }
      if (charLength(trimmed) > MAX_NEEDS_YOU_LEN) {
        return { error: overLength("needsYou", charLength(trimmed), MAX_NEEDS_YOU_LEN) };
      }
      entries.push(trimmed);
    }
    call.needsYou = entries;
  }

  if (body.replaceActions !== undefined) {
    if (typeof body.replaceActions !== "boolean") {
      return { error: "`replaceActions` must be a boolean." };
    }
    call.replaceActions = body.replaceActions;
  }

  if (body.actions !== undefined) {
    const validated = validateActionItems(body.actions, { tool: "session_status", min: 0 });
    if ("error" in validated) return validated;
    // Offers persist across turns (req 17), so an empty list can only be a
    // deliberate clear; adding nothing is a call that omits the field.
    if (validated.actions.length === 0 && call.replaceActions !== true) {
      return { error: "An empty `actions` list clears the offers, which needs `replaceActions: true`. Omit `actions` to leave them unchanged." };
    }
    call.actions = validated.actions;
  }

  if (!opts.hasStoredCard && call.status === undefined) {
    return { error: "This session has no status card yet, so `status` is required: say what the session is about, how far it got, and whether it is done." };
  }

  return call;
}

function overLength(field: string, actual: number, cap: number): string {
  return `\`${field}\` is ${actual} chars; the cap is ${cap}. Shorten it and call session_status again.`;
}
