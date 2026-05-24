/**
 * Review services — server-persisted, per-(session, file) reviews.
 *
 * Backs the unified review surface (docs/112-unified-review-surface):
 * markdown files get selection-anchored comments, code files get line-anchored
 * comments, and both share the same draft/sent/history lifecycle.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { FileReviewStore } from "../review-store.js";
import type {
  AgentReviewStore,
  AgentReviewCommentInput as AgentReviewStoreCommentInput,
} from "../agent-review-store.js";
import type {
  AgentReview,
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

function hashContent(content: string): string {
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

  const hash = hashContent(content);
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

// ---- Agent-authored review write-back (docs/151) ----

/** Max comments accepted in a single `submit_review_comments` call. */
export const MAX_REVIEW_COMMENTS = 50;
/** Max characters per comment text in a single `submit_review_comments` call. */
export const MAX_REVIEW_COMMENT_CHARS = 2048;

/**
 * Comment shape the review subagent submits via the `submit_review_comments`
 * MCP tool. snake_case to match the tool's JSON schema.
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

export interface SubmitAgentReviewResult {
  /** The persisted agent review (snapshot + comments). */
  review: AgentReview;
  /** Number of comments persisted. */
  added: number;
  /**
   * Rendered tool-response text returned to the subagent. The subagent is
   * instructed to echo this verbatim as its final assistant message so the
   * parent receives the structured findings via the Task tool result.
   */
  rendered: string;
}

/**
 * Validate that a payload item is a structurally well-formed review comment.
 * Throws a ServiceError that names the actual problem and the index in the
 * array that has it — so a malformed call yields actionable feedback instead
 * of the misleading "non-empty text" error the old validator returned for
 * shape-invalid input (docs/151 §6).
 */
function validateCommentShape(c: unknown, i: number): asserts c is { kind: string; text?: unknown; line?: unknown; quoted_text?: unknown; context_before?: unknown; context_after?: unknown } {
  if (c === null || typeof c !== "object" || Array.isArray(c)) {
    throw new ServiceError(
      400,
      `Comment at index ${i} is not an object. Each comment must be `
      + `{kind: "line", line: number, text: string} or `
      + `{kind: "selection", quoted_text: string, text: string}.`,
    );
  }
  const obj = c as Record<string, unknown>;
  if (obj.kind !== "line" && obj.kind !== "selection") {
    throw new ServiceError(
      400,
      `Comment at index ${i} has invalid kind "${String(obj.kind)}". `
      + `Expected "line" or "selection".`,
    );
  }
  if (typeof obj.text !== "string" || !obj.text.trim()) {
    throw new ServiceError(
      400,
      `Comment at index ${i} has empty or missing "text".`,
    );
  }
}

function truncateForRender(text: string, max = 200): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

/**
 * Build the structured tool-response text returned to the subagent. The
 * subagent is instructed to echo this verbatim so the parent receives it via
 * the Task tool's existing return-the-final-assistant-message contract — no
 * separate fetch tool needed.
 */
function renderReview(
  filePath: string,
  snapshotHash: string,
  comments: { kind: "line" | "selection"; line?: number; quotedText?: string; text: string }[],
): string {
  const shortHash = snapshotHash.slice(0, 8);
  if (comments.length === 0) {
    return `Review of ${filePath} (snapshot ${shortHash}, no findings).`;
  }
  const lines: string[] = [
    `Review of ${filePath} (snapshot ${shortHash}, ${comments.length} finding${comments.length === 1 ? "" : "s"}):`,
    "",
  ];
  for (const c of comments) {
    if (c.kind === "line") {
      lines.push(`line ${c.line ?? 0}`);
    } else {
      lines.push(`«${truncateForRender(c.quotedText ?? "")}»`);
    }
    lines.push(`  ${c.text.trim()}`);
    lines.push("");
  }
  lines.push("End of review.");
  return lines.join("\n");
}

/**
 * Persist the chat-native review subagent's findings as an immutable agent
 * review card (docs/151). Called by the orchestrator's `review-submit`
 * endpoint, which the worker relays to from the `submit_review_comments`
 * tool bridge.
 *
 * Contract:
 * - Snapshots the file at call time and stores it on the row. Selection
 *   anchors are matched against the snapshot (not the live file), so a
 *   comment whose quote was present at review time stays locatable even
 *   after the live file moves. A selection comment whose `quoted_text` is
 *   not present in the snapshot is rejected — the subagent saw the file it's
 *   quoting, so a miss here is a real bug on the agent side, not a
 *   re-anchoring concern.
 * - Returns a structured `rendered` string that the subagent is instructed
 *   to echo verbatim as its final assistant message.
 * - Enforces the size guardrails (`MAX_REVIEW_COMMENTS`,
 *   `MAX_REVIEW_COMMENT_CHARS`).
 * - Empty `comments` is a valid signal that the review ran and found
 *   nothing; a row is still created so the chat history shows the review
 *   happened.
 */
export async function submitAiReviewComments(
  agentReviewStore: AgentReviewStore,
  sessionId: string,
  filePath: string,
  workspaceDir: string,
  comments: unknown[],
): Promise<SubmitAgentReviewResult> {
  if (!Array.isArray(comments)) {
    throw new ServiceError(400, "`comments` must be an array.");
  }
  if (comments.length > MAX_REVIEW_COMMENTS) {
    throw new ServiceError(
      400,
      `Too many comments in one call (${comments.length}); the maximum is ${MAX_REVIEW_COMMENTS}.`,
    );
  }

  // Validate every item up front. Shape → kind → text, each with an
  // index-tagged error that names the actual problem.
  for (let i = 0; i < comments.length; i++) {
    validateCommentShape(comments[i], i);
    const c = comments[i] as { kind: string; text: string; line?: unknown; quoted_text?: unknown };
    if (c.text.length > MAX_REVIEW_COMMENT_CHARS) {
      throw new ServiceError(
        400,
        `Comment at index ${i} text exceeds the ${MAX_REVIEW_COMMENT_CHARS}-character limit.`,
      );
    }
    if (c.kind === "line") {
      if (!Number.isInteger(c.line) || (c.line as number) < 1) {
        throw new ServiceError(
          400,
          `Comment at index ${i} has missing or invalid "line"; expected a positive integer.`,
        );
      }
    } else {
      if (typeof c.quoted_text !== "string" || !c.quoted_text.trim()) {
        throw new ServiceError(
          400,
          `Comment at index ${i} has missing or empty "quoted_text".`,
        );
      }
    }
  }

  // Snapshot the file. Read it fresh — the snapshot is the canonical record
  // of "what the reviewer saw" for this card.
  const snapshotContent = (await readFileSafe(workspaceDir, filePath)) ?? "";
  const snapshotHash = hashContent(snapshotContent);
  const fileType = detectFileReviewType(filePath);

  // Anchor each comment against the snapshot. selection comments whose
  // quoted_text isn't found in the snapshot are rejected outright — the
  // subagent claimed to have quoted from this exact content, so a miss is a
  // bug, not drift.
  const storeInputs: AgentReviewStoreCommentInput[] = [];
  for (let i = 0; i < comments.length; i++) {
    const c = comments[i] as { kind: string; text: string; line?: number; quoted_text?: string; context_before?: string; context_after?: string };
    if (c.kind === "line") {
      if (fileType !== "code") {
        throw new ServiceError(
          400,
          `Comment at index ${i} is a line comment, but ${filePath} is not a code file.`,
        );
      }
      storeInputs.push({ kind: "line", line: c.line!, text: c.text });
      continue;
    }
    if (fileType !== "markdown") {
      throw new ServiceError(
        400,
        `Comment at index ${i} is a selection comment, but ${filePath} is not a markdown file.`,
      );
    }
    const quotedText = c.quoted_text ?? "";
    const contextBefore = c.context_before ?? "";
    const contextAfter = c.context_after ?? "";
    if (
      locateSelection(snapshotContent, { quotedText, contextBefore, contextAfter }) < 0
    ) {
      throw new ServiceError(
        400,
        `Comment at index ${i} quotes text that is not present in the snapshot. `
        + `The reviewer must quote from the file's current contents verbatim.`,
      );
    }
    storeInputs.push({
      kind: "selection",
      quotedText,
      contextBefore,
      contextAfter,
      text: c.text,
    });
  }

  const review = agentReviewStore.createReview({
    sessionId,
    filePath,
    fileType,
    snapshotContent,
    snapshotHash,
    comments: storeInputs,
  });

  const rendered = renderReview(
    filePath,
    snapshotHash,
    storeInputs.map((c) => ({
      kind: c.kind,
      ...(c.kind === "line" ? { line: c.line } : { quotedText: c.quotedText }),
      text: c.text,
    })),
  );

  return { review, added: storeInputs.length, rendered };
}

