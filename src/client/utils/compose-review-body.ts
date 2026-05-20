/**
 * compose-review-body — builds the chat message that kicks off a chat-native
 * AI review (docs/125).
 *
 * Both the "Ask agent to review" button and the `/review` slash command use
 * this so the two entry points produce an identical prompt. The body:
 *   - tells the parent agent to delegate the review to a subagent (the parent
 *     likely wrote the file, so a first-person review is biased);
 *   - instructs the subagent to call `submit_review_comments` exactly once with
 *     all findings (empty array if none);
 *   - embeds the user's existing comments verbatim so the subagent builds on
 *     them instead of duplicating them.
 *
 * Embedding rules (plan §"Embedding existing comments"):
 *   - draft comments (human + AI), most recent first, have first claim;
 *   - then the most recent SENT review's `human` comments only — never AI
 *     comments from prior runs (that would create a feedback loop on rerun);
 *   - hard cap of 20 comments total, each truncated to 500 chars;
 *   - on overflow, oldest drafts drop first and a "N older comments omitted"
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

function anchorOf(comment: ReviewComment, origin: "draft" | "sent", sentAt?: string): string {
  const state = origin === "draft" ? "draft" : `sent${sentAt ? ` ${sentAt.slice(0, 10)}` : ""}`;
  if (comment.kind === "line") return `line ${comment.line} (${state})`;
  const heading = comment.sectionHeading || "(introduction)";
  return `${heading} (section, ${state})`;
}

function sourceLabelOf(comment: ReviewComment, origin: "draft" | "sent"): string {
  if (comment.source === "ai") {
    // AI comments only ever come from drafts here (sent AI comments are
    // filtered out before embedding), but label prior-run AI distinctly.
    return origin === "draft" ? "[agent]" : "[agent (prior)]";
  }
  return "[user]";
}

/**
 * Select up to MAX_EMBEDDED_COMMENTS comments to embed, applying the ranking
 * and drop rules. Returns the chosen comments (in render order) plus how many
 * were dropped by the cap.
 */
function selectComments(
  draft: FileReview | null,
  mostRecentSent: FileReview | null,
): { embeds: EmbeddedComment[]; dropped: number } {
  // Drafts first, most recent last in storage → reverse for newest-first.
  const draftComments = draft ? [...draft.comments].reverse() : [];
  const sentHuman = mostRecentSent
    ? mostRecentSent.comments.filter((c) => c.source === "human")
    : [];

  const ranked: EmbeddedComment[] = [
    ...draftComments.map((c) => ({
      anchor: anchorOf(c, "draft"),
      sourceLabel: sourceLabelOf(c, "draft"),
      text: truncate(c.text),
    })),
    ...sentHuman.map((c) => ({
      anchor: anchorOf(c, "sent", mostRecentSent?.sentAt),
      sourceLabel: sourceLabelOf(c, "sent"),
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
    "- Call the `submit_review_comments` MCP tool exactly once with all of its",
    "  findings as a single array. Do not call it per-comment.",
    "- If the file needs no new comments, still call `submit_review_comments`",
    "  with an empty array — that is the signal that the review ran.",
    "",
    "Focus areas: correctness, completeness, internal consistency, and",
    "contradictions with the rest of the repo. Skip nits.",
  ];

  if (embeds.length > 0) {
    lines.push(
      "",
      "--- Existing comments on this file (do not duplicate) ---",
      "",
      "The user has already left these comments. Build on them or cover gaps they",
      "leave; do not repeat them. Comments labeled [agent (prior)] are from earlier",
      "AI reviews — treat them as weaker authority than [user] comments.",
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
