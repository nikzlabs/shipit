

const REVIEW_COMMAND = /^\/review(?:\s|$)/;
const REVIEW_ARGUMENT = /^\/review\s+@?(\S+)/;

export type ReviewRequest =
  | { ok: true; sessionId: string; targetFile: string }

  | { ok: false; message: string };

/**
 * A review is brokered to ShipIt's configured reviewer and has no second path —
 * the same-model `Task` fallback is gone (planning#571). `shipit agent run`
 * refuses while Multi-agent sessions is off, so without this the user spends a
 * whole turn to be told that; here they are told before it starts.
 */
export const REVIEW_NEEDS_MULTI_AGENT =
  "A review asks ShipIt's configured reviewer for a second opinion — turn on "
  + "Multi-agent sessions in Settings → Advanced.";

export function isReviewCommand(text: string): boolean {
  return REVIEW_COMMAND.test(text);
}

export function resolveReviewRequest(input: {

  text: string;

  sessionId: string | null | undefined;

  turnRunning: boolean;

  previewFile: string | null | undefined;

  subAgentsEnabled: boolean;
}): ReviewRequest {
  if (!input.sessionId) {
    return { ok: false, message: "Start a session before running /review." };
  }
  if (!input.subAgentsEnabled) {
    return { ok: false, message: REVIEW_NEEDS_MULTI_AGENT };
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
