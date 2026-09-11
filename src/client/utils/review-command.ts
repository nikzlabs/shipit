

const REVIEW_COMMAND = /^\/review(?:\s|$)/;
const REVIEW_ARGUMENT = /^\/review\s+@?(\S+)/;

export type ReviewRequest =
  | { ok: true; sessionId: string; targetFile: string }

  | { ok: false; message: string };

export function isReviewCommand(text: string): boolean {
  return REVIEW_COMMAND.test(text);
}

export function resolveReviewRequest(input: {

  text: string;

  sessionId: string | null | undefined;

  turnRunning: boolean;

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
