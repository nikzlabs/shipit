/**
 * Review services — server-persisted, per-(session, file) reviews.
 *
 * Backs the unified review surface (docs/112-unified-review-surface):
 * markdown files get selection-anchored comments, code files get line-anchored
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
  SelectionReviewComment,
} from "../../shared/types.js";
import { ServiceError } from "./types.js";

// ---- Selection anchoring (markdown only) ----

interface ReanchoredSplit {
  anchored: SelectionReviewComment[];
  orphaned: SelectionReviewComment[];
}

/**
 * Locate a selection-anchored comment in the current document body. Returns
 * the offset of the first match disambiguated by `contextBefore`/`contextAfter`
 * when the same `quotedText` appears multiple times, or `-1` if the quoted
 * text is no longer present.
 *
 * Disambiguation is best-effort: if no occurrence is bracketed by the saved
 * context windows, the first occurrence wins. The context match is exact —
 * it doesn't try to be clever about whitespace drift, because clever matching
 * is exactly how comments end up attached to the wrong text.
 */
export function locateSelection(
  content: string,
  comment: Pick<SelectionReviewComment, "quotedText" | "contextBefore" | "contextAfter">,
): number {
  if (comment.quotedText === "") return -1;
  let from = 0;
  let firstMatch = -1;
  while (from <= content.length) {
    const idx = content.indexOf(comment.quotedText, from);
    if (idx === -1) break;
    if (firstMatch === -1) firstMatch = idx;
    const before = content.slice(Math.max(0, idx - comment.contextBefore.length), idx);
    const after = content.slice(idx + comment.quotedText.length, idx + comment.quotedText.length + comment.contextAfter.length);
    if (
      (comment.contextBefore === "" || before.endsWith(comment.contextBefore)) &&
      (comment.contextAfter === "" || after.startsWith(comment.contextAfter))
    ) {
      return idx;
    }
    from = idx + 1;
  }
  return firstMatch;
}

/**
 * Walk a list of review comments and route each selection-anchored comment
 * either to "anchored" (its `quotedText` is still present in the doc) or
 * "orphaned" (the quoted text no longer exists). Line comments are always
 * anchored.
 */
export function reanchorComments(
  comments: ReviewComment[],
  content: string,
): ReanchoredSplit & { lines: ReviewComment[] } {
  const anchored: SelectionReviewComment[] = [];
  const orphaned: SelectionReviewComment[] = [];
  const lines: ReviewComment[] = [];

  for (const comment of comments) {
    if (comment.kind === "line") {
      lines.push(comment);
      continue;
    }
    if (locateSelection(content, comment) >= 0) {
      anchored.push(comment);
    } else {
      orphaned.push(comment);
    }
  }

  return { anchored, orphaned, lines };
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
  return reviewStore.createDraft(sessionId, filePath, fileType, hash);
}

/** Add a selection-anchored comment to a draft review. */
export function addSelectionComment(
  reviewStore: FileReviewStore,
  reviewId: string,
  quotedText: string,
  contextBefore: string,
  contextAfter: string,
  text: string,
  source: ReviewCommentSource = "human",
): ReviewComment {
  if (!text.trim()) {
    throw new ServiceError(400, "Comment text cannot be empty");
  }
  if (!quotedText.trim()) {
    throw new ServiceError(400, "Selection text cannot be empty");
  }
  const review = reviewStore.getReview(reviewId);
  if (!review) {
    throw new ServiceError(404, "Review not found");
  }
  if (review.status !== "draft") {
    throw new ServiceError(400, "Cannot add comments to a sent review");
  }
  if (review.fileType !== "markdown") {
    throw new ServiceError(400, "Selection comments are only valid on markdown files");
  }
  return reviewStore.addSelectionComment(
    reviewId,
    quotedText,
    contextBefore,
    contextAfter,
    text,
    source,
  );
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

export function buildReviewPrompt(
  filePath: string,
  fileType: FileReviewType,
  comments: ReviewComment[],
  fileContent: string,
): string {
  if (fileType === "markdown") {
    return buildMarkdownPrompt(filePath, comments, fileContent);
  }
  return buildCodePrompt(filePath, comments, fileContent);
}

function truncateForPrompt(text: string, max = 200): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function buildMarkdownPrompt(
  filePath: string,
  comments: ReviewComment[],
  fileContent: string,
): string {
  const { anchored, orphaned } = reanchorComments(comments, fileContent);
  const inDocOrder = [...anchored].sort((a, b) => {
    return locateSelection(fileContent, a) - locateSelection(fileContent, b);
  });

  let prompt = `I've reviewed ${filePath} and have the following feedback:\n\n`;

  for (const c of inDocOrder) {
    prompt += `> ${truncateForPrompt(c.quotedText)}\n\n`;
    prompt += `${c.text}\n\n`;
  }

  if (orphaned.length > 0) {
    prompt += `### Comments on removed/edited text\n\n`;
    prompt += `The following comments reference text that no longer appears verbatim in the document. `;
    prompt += `The feedback may still be relevant — consider whether it applies elsewhere.\n\n`;
    for (const c of orphaned) {
      prompt += `- (was: «${truncateForPrompt(c.quotedText, 80)}») ${c.text}\n`;
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
  const prompt = buildReviewPrompt(
    review.filePath,
    review.fileType,
    review.comments,
    content,
  );
  reviewStore.markSent(reviewId);
  const updated = reviewStore.getReview(reviewId);
  return { prompt, review: updated ?? review };
}

// ---- Chat-native AI review write-back (docs/125) ----

/** Max comments accepted in a single `submit_review_comments` call. */
export const MAX_REVIEW_COMMENTS = 50;
/** Max characters per comment text in a single `submit_review_comments` call. */
export const MAX_REVIEW_COMMENT_CHARS = 2048;

/**
 * Comment shape the review subagent submits via the `submit_review_comments`
 * MCP tool. snake_case to match the tool's JSON schema; `source` is
 * deliberately absent — it's set to `"ai"` server-side and cannot be supplied
 * by the caller.
 */
export type AiReviewCommentInput =
  | {
      kind: "selection";
      quoted_text: string;
      context_before?: string;
      context_after?: string;
      text: string;
    }
  | { kind: "line"; line: number; text: string };

export interface SubmitAiReviewResult {
  review: FileReview;
  /** Number of comments persisted. */
  added: number;
  /** Number of selection comments whose quoted text is not found in the current document (anchored as outdated). */
  outdated: number;
}

/**
 * Persist the chat-native review subagent's findings into the (session, file)
 * draft (docs/125). Called by the orchestrator's `review-submit` endpoint,
 * which the worker relays to from the `submit_review_comments` tool bridge.
 *
 * Contract:
 * - `source: "ai"` is forced server-side; the caller cannot set it.
 * - Section comments are re-anchored against the CURRENT file (not the version
 *   the subagent read). A comment whose heading no longer exists is persisted
 *   anyway (kept, not dropped) and counted as `outdated` — same posture as Send.
 * - Refuses the call if no draft exists. The review turn ensures a draft at
 *   start, so absence means the user sent or discarded it mid-review; creating
 *   a fresh draft here would attach AI comments the user never asked for.
 * - Enforces the size guardrails (`MAX_REVIEW_COMMENTS`, `MAX_REVIEW_COMMENT_CHARS`).
 */
export async function submitAiReviewComments(
  reviewStore: FileReviewStore,
  sessionId: string,
  filePath: string,
  workspaceDir: string,
  comments: AiReviewCommentInput[],
): Promise<SubmitAiReviewResult> {
  if (comments.length > MAX_REVIEW_COMMENTS) {
    throw new ServiceError(
      400,
      `Too many comments in one call (${comments.length}); the maximum is ${MAX_REVIEW_COMMENTS}.`,
    );
  }
  for (const c of comments) {
    if (typeof c.text !== "string" || !c.text.trim()) {
      throw new ServiceError(400, "Each comment must have non-empty text.");
    }
    if (c.text.length > MAX_REVIEW_COMMENT_CHARS) {
      throw new ServiceError(
        400,
        `Comment text exceeds the ${MAX_REVIEW_COMMENT_CHARS}-character limit.`,
      );
    }
  }

  // Resolve the draft to write into. Two no-draft cases, distinguished:
  //   - the most recent review is `sent` (the user sent it mid-review) → refuse,
  //     so we don't attach AI comments to a draft the user already shipped;
  //   - no review at all (the user closed the modal mid-review) → ensure a fresh
  //     draft so the review still lands somewhere.
  let draft = reviewStore.getDraft(sessionId, filePath);
  if (!draft) {
    const all = reviewStore.listReviews(sessionId, filePath);
    if (all.length > 0 && all[0].status === "sent") {
      throw new ServiceError(
        409,
        "This review was already sent during the review run. Re-run the review to start a fresh draft.",
      );
    }
    draft = await ensureDraftReview(reviewStore, sessionId, filePath, workspaceDir);
  }

  // Re-anchor selection comments against the current file, not the version the
  // subagent read while it worked.
  const content = (await readFileSafe(workspaceDir, filePath)) ?? "";

  let added = 0;
  let outdated = 0;
  for (const c of comments) {
    if (c.kind === "line") {
      // Line comments only make sense on code files; ignore mismatches rather
      // than failing the whole batch.
      if (draft.fileType !== "code") continue;
      if (!Number.isInteger(c.line) || c.line < 1) continue;
      reviewStore.addLineComment(draft.id, c.line, c.text, "ai");
      added++;
      continue;
    }
    if (draft.fileType !== "markdown") continue;
    const quotedText = c.quoted_text ?? "";
    if (!quotedText.trim()) continue;
    const contextBefore = c.context_before ?? "";
    const contextAfter = c.context_after ?? "";
    if (
      locateSelection(content, { quotedText, contextBefore, contextAfter }) < 0
    ) {
      outdated++;
    }
    reviewStore.addSelectionComment(
      draft.id,
      quotedText,
      contextBefore,
      contextAfter,
      c.text,
      "ai",
    );
    added++;
  }

  const updated = reviewStore.getReview(draft.id) ?? draft;
  return { review: updated, added, outdated };
}

