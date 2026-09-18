

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

/**
 * One manual step the user is submitting (docs/303 req 37). `done` is the
 * "I've done this" toggle; `note` is what they typed for that step. A step with
 * a note and no tick is an ANSWER — a refusal, a qualification, a blocker — and
 * must not read to the agent as one reported done.
 */
export interface ReportedStep {
  text: string;
  done: boolean;
  note?: string;
}

/**
 * The message is text an agent parses, so a step and its note must each stay
 * one item of it. A step's own text is folded onto one line, and every line of
 * a note is indented, not just the first — the field is a textarea, and an
 * unindented later line reading "- …" or a heading of its own would arrive as
 * another step rather than as more of this one.
 */
function oneLine(text: string): string {
  return text.split("\n").join(" ").trim();
}

/** The note rides under its own step, which is the whole point of the field. */
function stepLine(step: ReportedStep): string {
  const text = oneLine(step.text);
  if (!step.note) return `- ${text}`;
  return `- ${text}\n  Note: ${step.note.split("\n").join("\n  ")}`;
}

export function formatOfferedActionsMessage(
  selected: readonly OfferedAction[],
  steps: readonly ReportedStep[] = [],
): string {
  const parts: string[] = [];
  if (selected.length > 0) {
    const lead =
      selected.length === 1
        ? "I approved this action."
        : `I approved these ${selected.length} actions.`;
    const body = selected
      .map((offer, i) => `${i + 1}. ${offer.payload}\n   (${offerProvenance(offer)})`)
      .join("\n");
    parts.push(`${lead} ${INTENT_GUARD}\n\n${body}`);
  }
  // docs/303 req 29 — what the user did by hand rides the same message, so the
  // agent learns it at the moment it is told to act.
  const done = steps.filter((step) => step.done);
  if (done.length > 0) {
    const heading =
      done.length === 1 ? "I have done this manual step:" : "I have done these manual steps:";
    parts.push(`${heading}\n${done.map(stepLine).join("\n")}`);
  }
  // docs/303 req 37 — a step answered without being done gets its own heading,
  // because "I will not do this, use SQLite" is not a report of work finished.
  const answered = steps.filter((step) => !step.done && step.note);
  if (answered.length > 0) {
    const heading =
      answered.length === 1
        ? "I answered this manual step without doing it:"
        : "I answered these manual steps without doing them:";
    parts.push(`${heading}\n${answered.map(stepLine).join("\n")}`);
  }
  if (parts.length === 0) return "";
  return [`${CARD_MARKER} ${parts[0]}`, ...parts.slice(1)].join("\n\n");
}

/** The status card's "Add comment…", the transcript card's snapshot per offer. */
export function formatOfferedActionsComment(
  selected: readonly OfferedAction[],
  steps: readonly ReportedStep[] = [],
): string {
  const lines = [
    ...selected.map((offer) => `- ${offer.payload} (${offerProvenance(offer)})`),
    // Same boundaries as the submitted message: the user edits this in the
    // composer, and a note that breaks out of its step there is the same bug.
    ...steps.map((step) => {
      const prefix = step.done ? "done by hand" : "on this step";
      const line = `- ${prefix}: ${oneLine(step.text)}`;
      return step.note ? `${line}\n  Note: ${step.note.split("\n").join("\n  ")}` : line;
    }),
  ];
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
