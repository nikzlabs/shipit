/**
 * Review services — CRUD for design doc reviews, prompt construction,
 * AI review, and re-anchoring logic.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ReviewStore } from "../review-store.js";
import type { DocReview, ReviewComment, ReviewCommentSource } from "../../shared/types.js";
import { ServiceError } from "./types.js";

// ---- Section parsing (shared utility) ----

export interface MarkdownSection {
  heading: string;
  rawContent: string;
  index: number;
}

export function parseMarkdownSections(content: string): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  const lines = content.split("\n");
  let current: MarkdownSection = { heading: "", rawContent: "", index: 0 };

  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (current.heading || current.rawContent.trim()) {
        sections.push(current);
      }
      current = { heading: line, rawContent: `${line}\n`, index: sections.length };
    } else {
      current.rawContent += `${line}\n`;
    }
  }
  if (current.heading || current.rawContent.trim()) {
    sections.push(current);
  }

  return sections;
}

// ---- Re-anchoring ----

export function reanchorComments(
  comments: ReviewComment[],
  currentHeadings: string[],
): { anchored: ReviewComment[]; orphaned: ReviewComment[] } {
  const currentSet = new Map(currentHeadings.map((h, i) => [h, i]));
  const anchored: ReviewComment[] = [];
  const orphaned: ReviewComment[] = [];

  for (const comment of comments) {
    if (comment.sectionHeading === "") {
      anchored.push({ ...comment, sectionIndex: 0 });
    } else if (currentSet.has(comment.sectionHeading)) {
      anchored.push({ ...comment, sectionIndex: currentSet.get(comment.sectionHeading)! });
    } else {
      orphaned.push(comment);
    }
  }

  return { anchored, orphaned };
}

// ---- Hash utility ----

async function hashContent(content: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(content).digest("hex");
}

// ---- CRUD service functions ----

/** List all reviews for a feature. */
export function listReviews(reviewStore: ReviewStore, featureId: string): DocReview[] {
  return reviewStore.listReviews(featureId);
}

/** Get current draft review for a feature. */
export function getDraftReview(reviewStore: ReviewStore, featureId: string): DocReview | null {
  return reviewStore.getDraft(featureId);
}

/** Create a new draft review for a feature. */
export async function createDraftReview(
  reviewStore: ReviewStore,
  featureId: string,
  planPath: string,
  workspaceDir: string,
): Promise<DocReview> {
  const fullPath = path.resolve(workspaceDir, planPath);
  let content: string;
  try {
    content = await fs.readFile(fullPath, "utf-8");
  } catch {
    throw new ServiceError(404, "Plan file not found");
  }

  const hash = await hashContent(content);
  const sections = parseMarkdownSections(content);
  const headings = sections.map((s) => s.heading).filter((h) => h !== "");

  return reviewStore.createDraft(featureId, planPath, hash, headings);
}

/** Add a comment to a draft review. */
export function addReviewComment(
  reviewStore: ReviewStore,
  featureId: string,
  reviewId: string,
  sectionHeading: string,
  sectionIndex: number,
  text: string,
  source: ReviewCommentSource = "human",
): ReviewComment {
  if (!text.trim()) {
    throw new ServiceError(400, "Comment text cannot be empty");
  }
  const review = reviewStore.getReview(featureId, reviewId);
  if (!review) {
    throw new ServiceError(404, "Review not found");
  }
  if (review.status !== "draft") {
    throw new ServiceError(400, "Cannot add comments to a sent review");
  }
  return reviewStore.addComment(featureId, reviewId, { sectionHeading, sectionIndex, text, source });
}

/** Update a comment's text. */
export function updateReviewComment(
  reviewStore: ReviewStore,
  featureId: string,
  reviewId: string,
  commentId: string,
  text: string,
): void {
  if (!text.trim()) {
    throw new ServiceError(400, "Comment text cannot be empty");
  }
  const review = reviewStore.getReview(featureId, reviewId);
  if (!review) {
    throw new ServiceError(404, "Review not found");
  }
  reviewStore.updateComment(featureId, reviewId, commentId, text);
}

/** Delete a comment from a review. */
export function deleteReviewComment(
  reviewStore: ReviewStore,
  featureId: string,
  reviewId: string,
  commentId: string,
): void {
  const review = reviewStore.getReview(featureId, reviewId);
  if (!review) {
    throw new ServiceError(404, "Review not found");
  }
  reviewStore.deleteComment(featureId, reviewId, commentId);
}

/** Delete a draft review. */
export function deleteDraftReview(
  reviewStore: ReviewStore,
  featureId: string,
  reviewId: string,
): void {
  const review = reviewStore.getReview(featureId, reviewId);
  if (!review) {
    throw new ServiceError(404, "Review not found");
  }
  if (review.status !== "draft") {
    throw new ServiceError(400, "Cannot delete a sent review");
  }
  reviewStore.deleteDraft(featureId, reviewId);
}

// ---- Prompt construction ----

export function buildReviewPrompt(
  planPath: string,
  comments: ReviewComment[],
  currentHeadings: string[],
): string {
  const currentSet = new Set(currentHeadings);

  const anchored: ReviewComment[] = [];
  const orphaned: ReviewComment[] = [];
  for (const c of comments) {
    if (c.sectionHeading === "" || currentSet.has(c.sectionHeading)) {
      anchored.push(c);
    } else {
      orphaned.push(c);
    }
  }

  const grouped = new Map<string, ReviewComment[]>();
  for (const comment of anchored) {
    const key = comment.sectionHeading || "(Introduction)";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(comment);
  }

  let prompt = `I've reviewed the design doc at ${planPath} and have the following feedback:\n\n`;

  for (const [heading, sectionComments] of grouped) {
    prompt += `### ${heading}\n\n`;
    for (const c of sectionComments) {
      prompt += `- ${c.text}\n`;
    }
    prompt += "\n";
  }

  if (orphaned.length > 0) {
    prompt += `### Comments on removed/renamed sections\n\n`;
    prompt += `The following comments reference sections that no longer exist in the document. `;
    prompt += `The feedback may still be relevant — consider whether it applies elsewhere.\n\n`;
    for (const c of orphaned) {
      prompt += `- (was: ${c.sectionHeading}) ${c.text}\n`;
    }
    prompt += "\n";
  }

  prompt += "Please read the design doc, address each piece of feedback ";
  prompt += "by updating the plan, and explain what you changed.";

  return prompt;
}

/** Send a review — marks it as sent and returns the constructed prompt. */
export async function sendReview(
  reviewStore: ReviewStore,
  featureId: string,
  reviewId: string,
  sessionId: string,
  workspaceDir: string,
): Promise<{ prompt: string }> {
  const review = reviewStore.getReview(featureId, reviewId);
  if (!review) {
    throw new ServiceError(404, "Review not found");
  }
  if (review.status !== "draft") {
    throw new ServiceError(400, "Review already sent");
  }
  if (review.comments.length === 0) {
    throw new ServiceError(400, "Cannot send a review with no comments");
  }

  // Read current doc to get current headings for prompt construction
  const fullPath = path.resolve(workspaceDir, review.planPath);
  let currentHeadings: string[] = [];
  try {
    const content = await fs.readFile(fullPath, "utf-8");
    const sections = parseMarkdownSections(content);
    currentHeadings = sections.map((s) => s.heading).filter((h) => h !== "");
  } catch {
    // Doc may have been deleted — use stored headings as fallback
    currentHeadings = review.sectionHeadings;
  }

  const prompt = buildReviewPrompt(review.planPath, review.comments, currentHeadings);
  reviewStore.markSent(featureId, reviewId, sessionId);

  return { prompt };
}

// ---- AI Review ----

const AI_REVIEW_PROMPT_TEMPLATE = `You are reviewing a design document. Read the following plan and provide structured feedback.

<document path="{planPath}">
{content}
</document>

Respond with a JSON array of review comments. Each comment must reference a section heading from the document. Format:

\`\`\`json
[
  {
    "sectionHeading": "## Architecture",
    "text": "Your feedback here"
  }
]
\`\`\`

Focus on:
- Architectural concerns or missing considerations
- Edge cases not addressed
- Simplification opportunities
- Consistency with the rest of the codebase
- Missing test coverage

Be specific and actionable. Do not repeat what the document already says.`;

export async function generateAiReview(
  reviewStore: ReviewStore,
  featureId: string,
  reviewId: string,
  workspaceDir: string,
  generateText: (prompt: string, cwd: string) => Promise<string>,
): Promise<ReviewComment[]> {
  const review = reviewStore.getReview(featureId, reviewId);
  if (!review) {
    throw new ServiceError(404, "Review not found");
  }
  if (review.status !== "draft") {
    throw new ServiceError(400, "Cannot add AI review to a sent review");
  }

  const fullPath = path.resolve(workspaceDir, review.planPath);
  let content: string;
  try {
    content = await fs.readFile(fullPath, "utf-8");
  } catch {
    throw new ServiceError(404, "Plan file not found");
  }

  const sections = parseMarkdownSections(content);
  const prompt = AI_REVIEW_PROMPT_TEMPLATE
    .replace("{planPath}", review.planPath)
    .replace("{content}", content);

  const aiResponse = await generateText(prompt, workspaceDir);

  // Parse JSON from the AI response
  const jsonMatch = /\[[\s\S]*\]/.exec(aiResponse);
  if (!jsonMatch) {
    return [];
  }

  let parsed: { sectionHeading: string; text: string }[];
  try {
    parsed = JSON.parse(jsonMatch[0]) as { sectionHeading: string; text: string }[];
  } catch {
    return [];
  }

  const newComments: ReviewComment[] = [];
  for (const item of parsed) {
    if (!item.sectionHeading || !item.text) continue;
    const sectionIndex = sections.findIndex((s) => s.heading === item.sectionHeading);
    const comment = reviewStore.addComment(featureId, reviewId, {
      sectionHeading: item.sectionHeading,
      sectionIndex: sectionIndex >= 0 ? sectionIndex : 0,
      text: item.text,
      source: "ai",
    });
    newComments.push(comment);
  }

  return newComments;
}
