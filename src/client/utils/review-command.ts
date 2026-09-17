import {
  GLOBAL_SETTINGS,
  settingPath,
} from "../../server/shared/settings-catalogue/index.js";

const REVIEW_COMMAND = /^\/review(?:\s|$)/;
const REVIEW_ARGUMENT = /^\/review\s+@?(\S+)/;

export type ReviewRequest =
  | { ok: true; sessionId: string; targetFile: string }

  | { ok: false; message: string };

const SUB_AGENTS_SETTING = GLOBAL_SETTINGS["advanced.enableSubAgents"];

/**
 * A review is brokered to ShipIt's configured reviewer and has no second path —
 * the same-model `Task` fallback is gone (planning#571). `shipit agent run`
 * refuses while sub-agents are off, so without this the user spends a whole turn
 * to be told that; here they are told before it starts. The setting is named
 * from its declaration, not by hand, so the row it points at is the row the
 * dialog renders (planning#580).
 */
export const REVIEW_NEEDS_SUB_AGENTS =
  "A review asks ShipIt's configured reviewer for a second opinion — turn on "
  + `"${SUB_AGENTS_SETTING.label}" in ${settingPath(SUB_AGENTS_SETTING.tab)}.`;

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
    return { ok: false, message: REVIEW_NEEDS_SUB_AGENTS };
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
