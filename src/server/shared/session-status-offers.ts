import type { ActionChecklistItem } from "./types.js";

/**
 * docs/303 req 26 — an offer on the status card carries a description as well
 * as a label, so the user knows what an item is before they tick it. The rule
 * is the status card's alone: `propose_actions` keeps the description optional,
 * and the shared item validator therefore treats it as optional for both.
 *
 * One definition, used by the tool (which refuses without a round trip) and by
 * the route (which is the authority), so the two cannot drift apart.
 */
export function requireOfferDescriptions(
  actions: readonly ActionChecklistItem[],
): string | null {
  const missing = actions.filter((a) => !a.description);
  if (missing.length === 0) return null;
  const names = missing.map((a) => `"${a.id}"`).join(", ");
  return `Every offered action needs a one-line \`description\` as well as a \`label\`, and ${names} `
    + "has none: the user reads it to know what the action does before ticking it.";
}
