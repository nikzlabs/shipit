

import type { ActionChecklistCard } from "../../server/shared/types.js";

const CARD_MARKER = "[Action card → Submit]";

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
  const guard =
    "This is intent, not a literal command: before acting, check the current state and " +
    "adapt or decline anything now obsolete (branch merged, PR already exists, files moved).";
  const body = selected.map((a, i) => `${i + 1}. ${a.payload}`).join("\n");
  return `${lead} ${guard}\n\n${body}`;
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
