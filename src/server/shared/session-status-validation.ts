import type { ActionChecklistItem } from "./types.js";
import { charLength, validateActionItems } from "./propose-actions-validation.js";

/** docs/303 req 2 — the concision is the length, not a count of offers. */
export const MAX_STATUS_LEN = 240;
export const MAX_NEEDS_YOU_LEN = 240;

/**
 * One accepted `session_status` call, as a delta on the stored card.
 *
 * Every field is optional: an omitted one leaves the stored value alone, so a
 * call with nothing in it is the agent confirming the card still holds
 * (docs/303 req 14). `needsYou: ""` is the one field that clears.
 */
export interface ValidatedSessionStatus {
  status?: string;
  needsYou?: string;
  actions?: ActionChecklistItem[];
  replaceActions?: boolean;
}

export function validateSessionStatus(
  body: {
    status?: unknown;
    needsYou?: unknown;
    actions?: unknown;
    replaceActions?: unknown;
  },
  opts: { hasStoredCard: boolean },
): ValidatedSessionStatus | { error: string } {
  const call: ValidatedSessionStatus = {};

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
    if (typeof body.needsYou !== "string") {
      return { error: "`needsYou` must be a string; pass \"\" to clear it." };
    }
    const needsYou = body.needsYou.trim();
    if (charLength(needsYou) > MAX_NEEDS_YOU_LEN) {
      return { error: overLength("needsYou", charLength(needsYou), MAX_NEEDS_YOU_LEN) };
    }
    call.needsYou = needsYou;
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
