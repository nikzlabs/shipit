

import type { ActionChecklistCard, OfferedAction } from "../../server/shared/types.js";

const CARD_MARKER = "[Action card → Submit]";

const INTENT_GUARD =
  "This is intent, not a literal command: before acting, check the current state and " +
  "adapt or decline anything now obsolete (branch merged, PR already exists, files moved).";

function proposedDate(card: ActionChecklistCard): string {

  return card.createdAt.slice(0, 10);
}

function provenanceClause(card: ActionChecklistCard): string {
  let s = `proposed ${proposedDate(card)}`;
  if (card.branch) s += ` against branch \`${card.branch}\``;
  if (card.headSha) s += ` @ ${card.headSha}`;
  return s;
}

export function formatProposalMessage(
  card: ActionChecklistCard,
  selected: ActionChecklistCard["actions"],
): string {
  const lead =
    selected.length === 1
      ? `${CARD_MARKER} I approved this action (${provenanceClause(card)}).`
      : `${CARD_MARKER} I approved these ${selected.length} actions (${provenanceClause(card)}).`;
  const body = selected.map((a, i) => `${i + 1}. ${a.payload}`).join("\n");
  return `${lead} ${INTENT_GUARD}\n\n${body}`;
}

/** docs/303 req 16 — provenance belongs to the offer: offers outlive status writes. */
function offerProvenance(offer: OfferedAction): string {
  let s = `offered ${offer.offeredAt.slice(0, 10)}`;
  if (offer.branch) s += ` against branch \`${offer.branch}\``;
  if (offer.headSha) s += ` @ ${offer.headSha}`;
  return s;
}

export function formatOfferedActionsMessage(selected: readonly OfferedAction[]): string {
  const lead =
    selected.length === 1
      ? `${CARD_MARKER} I approved this action.`
      : `${CARD_MARKER} I approved these ${selected.length} actions.`;
  const body = selected
    .map((offer, i) => `${i + 1}. ${offer.payload}\n   (${offerProvenance(offer)})`)
    .join("\n");
  return `${lead} ${INTENT_GUARD}\n\n${body}`;
}

/** The status card's "Add comment…", the transcript card's snapshot per offer. */
export function formatOfferedActionsComment(selected: readonly OfferedAction[]): string {
  const lines = selected.map((offer) => `- ${offer.payload} (${offerProvenance(offer)})`);
  return `Re: offered actions\n${lines.join("\n")}\n\n`;
}

export function formatCommentSnapshot(
  card: ActionChecklistCard,
  selectedIds: ReadonlySet<string>,
): string {
  const heading = card.title ? `Re: ${card.title}` : "Re: proposed actions";
  const header = `${heading} (${provenanceClause(card)})`;
  const lines = card.actions
    .filter((a) => selectedIds.has(a.id))
    .map((a) => `- ${a.payload}`);
  return `${header}\n${lines.join("\n")}\n\n`;
}
