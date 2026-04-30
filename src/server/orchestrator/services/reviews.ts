/**
 * Review services — server-persisted, per-(session, file) reviews.
 *
 * Backs the unified review surface (docs/112-unified-review-surface):
 * markdown files get section-anchored comments, code files get line-anchored
 * comments, and both share the same draft/sent/history lifecycle.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { FileReviewStore } from "../review-store.js";
import type {
  FileReview,
  FileReviewType,
  ReviewComment,
  ReviewCommentSource,
} from "../../shared/types.js";
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

// ---- Re-anchoring (markdown only) ----

interface ReanchoredSplit {
  anchored: ReviewComment[];
  orphaned: ReviewComment[];
}

/**
 * Walk a list of review comments and route each section-anchored comment
 * either to the new section it now belongs to (heading match) or to the
 * orphaned bucket if its section no longer exists. Line comments and
 * preamble comments are always anchored.
 */
export function reanchorComments(
  comments: ReviewComment[],
  currentHeadings: string[],
): ReanchoredSplit {
  const headingIndex = new Map(currentHeadings.map((h, i) => [h, i]));
  const anchored: ReviewComment[] = [];
  const orphaned: ReviewComment[] = [];

  for (const comment of comments) {
    if (comment.kind === "line") {
      anchored.push(comment);
      continue;
    }
    if (comment.sectionHeading === "") {
      anchored.push({ ...comment, sectionIndex: 0 });
    } else if (headingIndex.has(comment.sectionHeading)) {
      anchored.push({ ...comment, sectionIndex: headingIndex.get(comment.sectionHeading)! });
    } else {
      orphaned.push(comment);
    }
  }

  return { anchored, orphaned };
}

// ---- File-type detection ----

const MARKDOWN_EXTS = new Set(["md", "mdx", "markdown"]);

export function detectFileReviewType(filePath: string): FileReviewType {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return MARKDOWN_EXTS.has(ext) ? "markdown" : "code";
}

// ---- Hash utility ----

async function hashContent(content: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(content).digest("hex");
}

// ---- Filesystem helpers ----

async function readFileSafe(workspaceDir: string, filePath: string): Promise<string | null> {
  const fullPath = path.resolve(workspaceDir, filePath);
  // Defend against path traversal: must remain inside workspace.
  if (!fullPath.startsWith(path.resolve(workspaceDir))) {
    throw new ServiceError(400, "Invalid file path");
  }
  try {
    return await fs.readFile(fullPath, "utf-8");
  } catch {
    return null;
  }
}

// ---- CRUD service functions ----

/** List all reviews (drafts + sent) for a (session, file) pair, newest first. */
export function listFileReviews(
  reviewStore: FileReviewStore,
  sessionId: string,
  filePath: string,
): FileReview[] {
  return reviewStore.listReviews(sessionId, filePath);
}

/** Get the current draft review for a (session, file), or null. */
export function getDraftReview(
  reviewStore: FileReviewStore,
  sessionId: string,
  filePath: string,
): FileReview | null {
  return reviewStore.getDraft(sessionId, filePath);
}

/**
 * Ensure a draft exists for the (session, file). Creates one if none exists,
 * snapshotting the current file content. Returns the existing draft otherwise.
 */
export async function ensureDraftReview(
  reviewStore: FileReviewStore,
  sessionId: string,
  filePath: string,
  workspaceDir: string,
): Promise<FileReview> {
  const existing = reviewStore.getDraft(sessionId, filePath);
  if (existing) return existing;

  const fileType = detectFileReviewType(filePath);
  const content = await readFileSafe(workspaceDir, filePath);
  if (content === null) {
    throw new ServiceError(404, "File not found");
  }

  const hash = await hashContent(content);
  let headings: string[] = [];
  if (fileType === "markdown") {
    headings = parseMarkdownSections(content)
      .map((s) => s.heading)
      .filter((h) => h !== "");
  }

  return reviewStore.createDraft(sessionId, filePath, fileType, hash, headings);
}

/** Add a section-anchored comment to a draft review. */
export function addSectionComment(
  reviewStore: FileReviewStore,
  reviewId: string,
  sectionHeading: string,
  sectionIndex: number,
  text: string,
  source: ReviewCommentSource = "human",
): ReviewComment {
  if (!text.trim()) {
    throw new ServiceError(400, "Comment text cannot be empty");
  }
  const review = reviewStore.getReview(reviewId);
  if (!review) {
    throw new ServiceError(404, "Review not found");
  }
  if (review.status !== "draft") {
    throw new ServiceError(400, "Cannot add comments to a sent review");
  }
  if (review.fileType !== "markdown") {
    throw new ServiceError(400, "Section comments are only valid on markdown files");
  }
  return reviewStore.addSectionComment(reviewId, sectionHeading, sectionIndex, text, source);
}

/** Add a line-anchored comment to a draft review. */
export function addLineComment(
  reviewStore: FileReviewStore,
  reviewId: string,
  line: number,
  text: string,
  source: ReviewCommentSource = "human",
): ReviewComment {
  if (!text.trim()) {
    throw new ServiceError(400, "Comment text cannot be empty");
  }
  if (!Number.isInteger(line) || line < 1) {
    throw new ServiceError(400, "Line must be a positive integer");
  }
  const review = reviewStore.getReview(reviewId);
  if (!review) {
    throw new ServiceError(404, "Review not found");
  }
  if (review.status !== "draft") {
    throw new ServiceError(400, "Cannot add comments to a sent review");
  }
  if (review.fileType !== "code") {
    throw new ServiceError(400, "Line comments are only valid on code files");
  }
  return reviewStore.addLineComment(reviewId, line, text, source);
}

/** Update a comment's text. */
export function updateReviewComment(
  reviewStore: FileReviewStore,
  reviewId: string,
  commentId: string,
  text: string,
): void {
  if (!text.trim()) {
    throw new ServiceError(400, "Comment text cannot be empty");
  }
  const review = reviewStore.getReview(reviewId);
  if (!review) {
    throw new ServiceError(404, "Review not found");
  }
  if (review.status !== "draft") {
    throw new ServiceError(400, "Cannot edit a sent review");
  }
  reviewStore.updateComment(reviewId, commentId, text);
}

/** Delete a comment from a review. */
export function deleteReviewComment(
  reviewStore: FileReviewStore,
  reviewId: string,
  commentId: string,
): void {
  const review = reviewStore.getReview(reviewId);
  if (!review) {
    throw new ServiceError(404, "Review not found");
  }
  if (review.status !== "draft") {
    throw new ServiceError(400, "Cannot edit a sent review");
  }
  reviewStore.deleteComment(reviewId, commentId);
}

/** Delete a draft review entirely. */
export function deleteDraftReview(reviewStore: FileReviewStore, reviewId: string): void {
  const review = reviewStore.getReview(reviewId);
  if (!review) {
    throw new ServiceError(404, "Review not found");
  }
  if (review.status !== "draft") {
    throw new ServiceError(400, "Cannot delete a sent review");
  }
  reviewStore.deleteDraft(reviewId);
}

// ---- Prompt construction ----

interface SectionGroup {
  heading: string;
  comments: ReviewComment[];
}

export function buildReviewPrompt(
  filePath: string,
  fileType: FileReviewType,
  comments: ReviewComment[],
  fileContent: string,
  currentHeadings: string[],
): string {
  if (fileType === "markdown") {
    return buildMarkdownPrompt(filePath, comments, currentHeadings);
  }
  return buildCodePrompt(filePath, comments, fileContent);
}

function buildMarkdownPrompt(
  filePath: string,
  comments: ReviewComment[],
  currentHeadings: string[],
): string {
  const currentSet = new Set(currentHeadings);
  const anchored: ReviewComment[] = [];
  const orphaned: ReviewComment[] = [];
  for (const c of comments) {
    if (c.kind !== "section") {
      anchored.push(c);
      continue;
    }
    if (c.sectionHeading === "" || currentSet.has(c.sectionHeading)) {
      anchored.push(c);
    } else {
      orphaned.push(c);
    }
  }

  const grouped = new Map<string, ReviewComment[]>();
  for (const comment of anchored) {
    if (comment.kind !== "section") continue;
    const key = comment.sectionHeading || "(Introduction)";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(comment);
  }
  const groups: SectionGroup[] = Array.from(grouped, ([heading, cs]) => ({ heading, comments: cs }));

  let prompt = `I've reviewed ${filePath} and have the following feedback:\n\n`;

  for (const group of groups) {
    prompt += `### ${group.heading}\n\n`;
    for (const c of group.comments) {
      prompt += `- ${c.text}\n`;
    }
    prompt += "\n";
  }

  if (orphaned.length > 0) {
    prompt += `### Comments on removed/renamed sections\n\n`;
    prompt += `The following comments reference sections that no longer exist in the document. `;
    prompt += `The feedback may still be relevant — consider whether it applies elsewhere.\n\n`;
    for (const c of orphaned) {
      if (c.kind !== "section") continue;
      prompt += `- (was: ${c.sectionHeading}) ${c.text}\n`;
    }
    prompt += "\n";
  }

  prompt += `Please read ${filePath}, address each piece of feedback by `;
  prompt += "updating the file, and explain what you changed.";
  return prompt;
}

function buildCodePrompt(
  filePath: string,
  comments: ReviewComment[],
  fileContent: string,
): string {
  const lines = fileContent.split("\n");
  const lineComments = comments
    .filter((c): c is Extract<ReviewComment, { kind: "line" }> => c.kind === "line")
    .sort((a, b) => a.line - b.line);

  let prompt = `I have the following comments on ${filePath}:\n\n`;

  for (const comment of lineComments) {
    const start = Math.max(0, comment.line - 3);
    const end = Math.min(lines.length, comment.line + 2);
    const snippet = lines.slice(start, end)
      .map((l, i) => {
        const lineNum = start + i + 1;
        const marker = lineNum === comment.line ? "→" : " ";
        return `${marker} ${lineNum} │ ${l}`;
      })
      .join("\n");

    prompt += `**${filePath}:${comment.line}**\n`;
    prompt += `\`\`\`\n${snippet}\n\`\`\`\n`;
    prompt += `Comment: ${comment.text}\n\n`;
  }

  prompt += "Please address each comment.";
  return prompt;
}

/**
 * Send a review — marks it sent and returns the constructed prompt.
 * Reads the file from disk to get current content/headings for the prompt.
 */
export async function sendReview(
  reviewStore: FileReviewStore,
  reviewId: string,
  workspaceDir: string,
): Promise<{ prompt: string; review: FileReview }> {
  const review = reviewStore.getReview(reviewId);
  if (!review) {
    throw new ServiceError(404, "Review not found");
  }
  if (review.status !== "draft") {
    throw new ServiceError(400, "Review already sent");
  }
  if (review.comments.length === 0) {
    throw new ServiceError(400, "Cannot send a review with no comments");
  }

  const content = (await readFileSafe(workspaceDir, review.filePath)) ?? "";
  let currentHeadings: string[] = review.sectionHeadings;
  if (review.fileType === "markdown" && content) {
    currentHeadings = parseMarkdownSections(content)
      .map((s) => s.heading)
      .filter((h) => h !== "");
  }

  const prompt = buildReviewPrompt(
    review.filePath,
    review.fileType,
    review.comments,
    content,
    currentHeadings,
  );
  reviewStore.markSent(reviewId);
  const updated = reviewStore.getReview(reviewId);
  return { prompt, review: updated ?? review };
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

/**
 * Generate AI review comments for a markdown draft. Currently only supported
 * for markdown files — code AI review is gated until we know the output is
 * useful (see plan §"Decisions and open questions").
 */
export async function generateAiReview(
  reviewStore: FileReviewStore,
  reviewId: string,
  workspaceDir: string,
  generateText: (prompt: string, cwd: string) => Promise<string>,
): Promise<ReviewComment[]> {
  const review = reviewStore.getReview(reviewId);
  if (!review) {
    throw new ServiceError(404, "Review not found");
  }
  if (review.status !== "draft") {
    throw new ServiceError(400, "Cannot add AI review to a sent review");
  }
  if (review.fileType !== "markdown") {
    throw new ServiceError(400, "AI Review is only available for markdown files");
  }

  const content = await readFileSafe(workspaceDir, review.filePath);
  if (content === null) {
    throw new ServiceError(404, "File not found");
  }

  const sections = parseMarkdownSections(content);
  const prompt = AI_REVIEW_PROMPT_TEMPLATE
    .replace("{planPath}", review.filePath)
    .replace("{content}", content);

  const aiResponse = await generateText(prompt, workspaceDir);

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
    const comment = reviewStore.addSectionComment(
      reviewId,
      item.sectionHeading,
      sectionIndex >= 0 ? sectionIndex : 0,
      item.text,
      "ai",
    );
    newComments.push(comment);
  }

  return newComments;
}
