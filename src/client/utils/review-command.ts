/**
 * Whether a `/review` typed in the composer can be sent, and what it reviews.
 *
 * docs/293 req 4 — no attachment is dropped without the user being told. This
 * command has three ways to turn a send away, and `App` used to decide them
 * inline while `MessageInput` cleared the composer regardless: the toast said
 * why the review was refused, and said nothing about the attachment that went
 * with it. `App` now reports the refusal back to the composer, and the decision
 * lives here so all three branches can be tested without rendering `App`.
 *
 * Deliberately pure: every input is passed in, so a test states the world and
 * reads back the answer.
 */

/** `/review`, optionally followed by `@path` or a bare path. */
const REVIEW_COMMAND = /^\/review(?:\s|$)/;
const REVIEW_ARGUMENT = /^\/review\s+@?(\S+)/;

export type ReviewRequest =
  | { ok: true; sessionId: string; targetFile: string }
  /** Refused. `message` is the toast, and nothing is dispatched. */
  | { ok: false; message: string };

export function isReviewCommand(text: string): boolean {
  return REVIEW_COMMAND.test(text);
}

export function resolveReviewRequest(input: {
  /** The trimmed composer text, already known to be a `/review`. */
  text: string;
  /** The session on screen, absent on a route that has none yet. */
  sessionId: string | null | undefined;
  /** Whether a turn is already running in that session. */
  turnRunning: boolean;
  /** The file open in preview, which `/review` with no argument reviews. */
  previewFile: string | null | undefined;
}): ReviewRequest {
  if (!input.sessionId) {
    return { ok: false, message: "Start a session before running /review." };
  }
  if (input.turnRunning) {
    return {
      ok: false,
      message: "Wait for the current turn to finish before running /review.",
    };
  }
  const targetFile = REVIEW_ARGUMENT.exec(input.text)?.[1] ?? input.previewFile;
  if (!targetFile) {
    return {
      ok: false,
      message:
        "/review needs a file — open one in preview, or use /review @path/to/file.",
    };
  }
  return { ok: true, sessionId: input.sessionId, targetFile };
}
