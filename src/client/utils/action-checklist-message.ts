/**
 * action-checklist-message — pure builders for the two messages an
 * `ActionChecklistCard` produces (docs/207 / SHI-153).
 *
 * Both are built from the action `payload`s (the self-contained instructions),
 * NOT the short display labels, so they stand alone no matter how much time has
 * passed since the card was emitted — the card outlives the turn, the agent, even
 * a destroyed-and-re-cloned container. Both are stamped with the card's
 * immutable, emit-time provenance (when proposed + branch/HEAD) so the agent can
 * inspect current state and adapt or decline an action that is now obsolete.
 *
 * Kept as pure functions (no React, no store) so they're trivially unit-tested
 * and shared by Submit (concatenate selected payloads → one turn) and Add
 * comment (snapshot the whole menu as `[x]`/`[ ]` payload lines → seed composer).
 */

import type { ActionChecklistCard } from "../../server/shared/types.js";

/** Human "proposed <date>" stamp from the immutable `createdAt`. */
function proposedDate(card: ActionChecklistCard): string {
  // createdAt is an ISO string; the date portion is enough for provenance.
  return card.createdAt.slice(0, 10);
}

/** "proposed 2026-06-15 against branch `x` @ abc12345" — provenance clause. */
function provenanceClause(card: ActionChecklistCard): string {
  let s = `proposed ${proposedDate(card)}`;
  if (card.branch) s += ` against branch \`${card.branch}\``;
  if (card.headSha) s += ` @ ${card.headSha}`;
  return s;
}

/**
 * The Submit message: the selected actions' payloads concatenated into ONE
 * coherent instruction, framed so the agent re-checks current state first. The
 * caller guarantees `selected` is non-empty (Submit is disabled otherwise).
 */
export function formatProposalMessage(
  card: ActionChecklistCard,
  selected: ActionChecklistCard["actions"],
): string {
  const lead =
    selected.length === 1
      ? `This action was ${provenanceClause(card)}.`
      : `These ${selected.length} actions were ${provenanceClause(card)}.`;
  const guard =
    "Before acting, check the current state and adapt or decline anything now obsolete " +
    "(branch merged, PR already exists, files moved).";
  const body = selected.map((a, i) => `${i + 1}. ${a.payload}`).join("\n");
  return `${lead} ${guard}\n\n${body}`;
}

/**
 * The Add comment… snapshot seeded into the main composer: ONLY the selected
 * actions, each on its own line as a `- ` bullet, using the action `payload` so
 * the seeded path is cold-context-safe just like Submit. Unselected actions are
 * omitted entirely — they are not filled into the composer at all, so the user
 * starts from a clean slate of just what they leaned toward (plus, with no
 * selection, only the `Re:` header). No `[x]`/`[ ]` checkbox marker is needed:
 * every seeded line is by definition selected, so the ticked/unticked
 * distinction is gone. A trailing blank line leaves the cursor where the user
 * appends their own words (typed or dictated), and the lines are freely editable
 * before sending.
 */
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
