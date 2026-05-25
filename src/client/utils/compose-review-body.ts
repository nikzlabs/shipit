/**
 * compose-review-body — builds the chat message that kicks off a chat-native
 * AI review (docs/125, updated by docs/151).
 *
 * Both the "Ask agent to review" button and the `/review` slash command use
 * this so the two entry points produce an identical prompt. The body:
 *   - tells the parent agent to delegate the review to a subagent (the parent
 *     likely wrote the file, so a first-person review is biased);
 *   - instructs the subagent to call `submit_review_comments` exactly once with
 *     only high-signal findings (empty array if none);
 *   - instructs the subagent to echo the tool result verbatim as its final
 *     assistant message so the structured findings reach the parent through
 *     the Task tool result (docs/151);
 *   - embeds the user's existing human-authored comments verbatim so the
 *     subagent builds on them instead of duplicating them.
 *
 * Embedding rules (docs/151 supersedes the docs/125 rules):
 *   - draft `human` comments only, most recent first — AI comments no longer
 *     live in the draft bucket (they have their own immutable card history);
 *   - then the most recent SENT review's `human` comments only;
 *   - hard cap of 20 comments total, each truncated to 500 chars;
 *   - on overflow, oldest entries drop first and a "N older comments omitted"
 *     note is appended so the subagent knows the embed is partial.
 */

import type { FileReview, ReviewComment } from "../../server/shared/types.js";

const MAX_EMBEDDED_COMMENTS = 20;
const MAX_COMMENT_CHARS = 500;

interface EmbeddedComment {
  anchor: string;
  sourceLabel: string;
  text: string;
}

function truncate(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_COMMENT_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_COMMENT_CHARS)}…`;
}

function truncateQuote(text: string, max = 80): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

function anchorOf(comment: ReviewComment, origin: "draft" | "sent", sentAt?: string): string {
  const state = origin === "draft" ? "draft" : `sent${sentAt ? ` ${sentAt.slice(0, 10)}` : ""}`;
  if (comment.kind === "line") return `line ${comment.line} (${state})`;
  const quote = truncateQuote(comment.quotedText) || "(empty selection)";
  return `«${quote}» (selection, ${state})`;
}

/**
 * Select up to MAX_EMBEDDED_COMMENTS comments to embed, applying the ranking
 * and drop rules. Returns the chosen comments (in render order) plus how many
 * were dropped by the cap.
 *
 * Drops AI-source comments at every step: post-docs/151 the draft is human-only
 * anyway, but the filter is kept defensively (a session whose draft still
 * carries pre-migration AI rows in `sent` history wouldn't re-embed them).
 */
function selectComments(
  draft: FileReview | null,
  mostRecentSent: FileReview | null,
): { embeds: EmbeddedComment[]; dropped: number } {
  // Drafts first, most recent last in storage → reverse for newest-first.
  const draftHuman = draft
    ? [...draft.comments].reverse().filter((c) => c.source === "human")
    : [];
  const sentHuman = mostRecentSent
    ? mostRecentSent.comments.filter((c) => c.source === "human")
    : [];

  const ranked: EmbeddedComment[] = [
    ...draftHuman.map((c) => ({
      anchor: anchorOf(c, "draft"),
      sourceLabel: "[user]",
      text: truncate(c.text),
    })),
    ...sentHuman.map((c) => ({
      anchor: anchorOf(c, "sent", mostRecentSent?.sentAt),
      sourceLabel: "[user]",
      text: truncate(c.text),
    })),
  ];

  const embeds = ranked.slice(0, MAX_EMBEDDED_COMMENTS);
  return { embeds, dropped: Math.max(0, ranked.length - embeds.length) };
}

export function composeReviewMessage(
  filePath: string,
  draft: FileReview | null,
  history: FileReview[],
): string {
  const mostRecentSent = history.find((r) => r.status === "sent") ?? null;
  const { embeds, dropped } = selectComments(draft, mostRecentSent);

  const lines: string[] = [
    `Review ${filePath}.`,
    "",
    "Before reviewing: spawn a subagent and let it perform the review. You (the",
    "parent) likely wrote or edited this file earlier in this conversation, so a",
    "first-person review will be biased toward defending the existing text.",
    "Do not review it yourself.",
    "",
    "Brief the subagent to:",
    "- Approach the file fresh, treating it as work it has not seen.",
    "- Read related files in the repo as needed for context.",
    "- Report only material issues that would block correctness, safety,",
    "  completeness, or the user's stated goal. Do not report style opinions,",
    "  wording preferences, speculative concerns, or nice-to-have improvements.",
    "- Before submitting any finding, verify that it has a concrete user impact",
    "  and a specific fix. If you cannot name both, omit it.",
    "- Submit at most 5 findings, ordered by severity. If there are more than 5,",
    "  keep only the ones most likely to change whether this should ship.",
    "- Call the `submit_review_comments` MCP tool exactly once with the selected",
    "  findings as a single array. Do not call it per-comment.",
    "- If the file has no material findings, still call `submit_review_comments`",
    "  with an empty array — that is the signal that the review ran.",
    "- After calling `submit_review_comments`, return the tool result verbatim",
    "  as your final assistant message. Do not paraphrase, do not add",
    "  commentary, do not summarize — the parent needs the exact rendered list.",
    "",
    "Review standard: this is a convergence pass, not an exhaustive critique.",
    "Prefer no comment over a weak comment. Skip nits.",
    "",
    "After the subagent submits its findings: you (the parent) apply the fixes",
    "for material findings only — the subagent only reviews, it does not edit.",
    "Then spawn one fresh subagent to re-review the updated file. On that",
    "re-review, fix only blockers or regressions introduced by the changes.",
    "Do not keep looping on lower-severity follow-up suggestions; summarize",
    "non-blocking leftovers in chat only if they are worth the user's attention.",
  ];

  if (embeds.length > 0) {
    lines.push(
      "",
      "--- Existing comments on this file (do not duplicate) ---",
      "",
      "The user has already left these comments. Build on them or cover gaps they",
      "leave; do not repeat them.",
      "",
    );
    for (const e of embeds) {
      lines.push(e.anchor, `  ${e.sourceLabel} ${e.text}`, "");
    }
    if (dropped > 0) {
      lines.push(`(${dropped} older comment${dropped === 1 ? "" : "s"} omitted)`);
    }
    lines.push("---");
  }

  return lines.join("\n");
}
