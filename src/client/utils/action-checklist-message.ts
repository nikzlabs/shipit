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
 * The Submit message is **card-injected** (templated by the Submit button, not
 * hand-typed by the user), so — mirroring `release-confirm-message.ts` — it leads
 * with an explicit provenance marker (`[Action card → Submit]`) and frames the
 * body as *intent* ("I approved these actions … re-check current state before
 * acting") rather than a literal command. The marker lets the agent tell a
 * templated button-press from a typed instruction and apply judgment instead of
 * obeying the string verbatim. The Add comment… snapshot is seeded into the
 * user's *composer* for them to edit and send — not auto-injected as an agent
 * instruction — so it carries the lighter `Re: <title>` provenance header and no
 * card marker (a marker would imply an agent directive the user hasn't sent yet).
 *
 * Kept as pure functions (no React, no store) so they're trivially unit-tested
 * and shared by Submit (concatenate selected payloads → one turn) and Add
 * comment (snapshot the whole menu as `[x]`/`[ ]` payload lines → seed composer).
 */

import type { ActionChecklistCard } from "../../server/shared/types.js";

/**
 * Provenance marker stamped on the card-injected Submit message so the agent can
 * tell a templated card submission from a hand-typed instruction and apply
 * judgment instead of obeying the literal string. Mirrors
 * `release-confirm-message.ts`'s `CARD_MARKER`.
 */
const CARD_MARKER = "[Action card → Submit]";

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
 * coherent instruction, framed so the agent re-checks current state first. Leads
 * with the `CARD_MARKER` provenance prefix and intent framing (mirroring
 * `release-confirm-message.ts`) so the agent treats it as card-injected intent —
 * not a hand-typed directive — and applies judgment. The caller guarantees
 * `selected` is non-empty (Submit is disabled otherwise).
 */
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
