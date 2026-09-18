import type { SessionMessageOrigin } from "../shared/types.js";
import { fillPromptTokens, loadPrompt } from "./load-prompt.js";

const SESSION_MESSAGE_PROMPT = loadPrompt(import.meta.url, "./session-message-origin.md");

export function formatSessionMessagePrompt(body: string, origin: SessionMessageOrigin): string {
  return fillPromptTokens(SESSION_MESSAGE_PROMPT, {
    RELATION: origin.relation.toUpperCase(),
    SESSION_TITLE: origin.sessionTitle,
    SESSION_ID: origin.sessionId,
    MESSAGE_BODY: body,
  });
}
