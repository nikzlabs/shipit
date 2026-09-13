import type { ApiStyle } from "../../shared/catalogue/index.js";
import { createAnthropicMessagesCall } from "./anthropic-messages.js";
import { createOpenAiChatCompletionsCall } from "./openai-chat-completions.js";
import { createOpenAiResponsesCall } from "./openai-responses.js";
import type { DirectCall } from "./types.js";

export * from "./types.js";
export { createAnthropicMessagesCall } from "./anthropic-messages.js";
export { createOpenAiChatCompletionsCall } from "./openai-chat-completions.js";
export { createOpenAiResponsesCall } from "./openai-responses.js";

// Keep in step with DIRECT_CALL_PATHS: a style the catalogue offers with no
// client here would resolve to a URL nothing can call. index.test.ts pins it.
const CLIENTS: Partial<Record<ApiStyle, (fetchImpl: typeof fetch) => DirectCall>> = {
  "anthropic-messages": createAnthropicMessagesCall,
  "openai-chat-completions": createOpenAiChatCompletionsCall,
  "openai-responses": createOpenAiResponsesCall,
};

export function directCallForStyle(
  style: ApiStyle,
  fetchImpl: typeof fetch = fetch,
): DirectCall | undefined {
  return CLIENTS[style]?.(fetchImpl);
}

export function directCallStyles(): ApiStyle[] {
  return Object.keys(CLIENTS) as ApiStyle[];
}
