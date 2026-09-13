import { DIRECT_CALL_PATHS, joinEndpoint } from "../../shared/catalogue/index.js";
import { maxOutputTokens, postJson, requireText, uncachedInput } from "./http.js";
import type { DirectCall } from "./types.js";

const LABEL = "OpenAI Chat Completions";

interface ChatCompletionsResponse {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  };
}

/**
 * `max_tokens`, not `max_completion_tokens`: every service this style resolves
 * to is a gateway or an OpenAI-compatible vendor that takes the older field,
 * and OpenAI's own newest models — the ones that reject it — resolve to
 * Responses first through the catalogue's style order.
 */
export function createOpenAiChatCompletionsCall(fetchImpl: typeof fetch = fetch): DirectCall {
  return async (req) => {
    const data = (await postJson(
      fetchImpl,
      joinEndpoint(req.baseUrl, DIRECT_CALL_PATHS["openai-chat-completions"]),
      { Authorization: `Bearer ${req.apiKey}`, ...req.headers },
      {
        model: req.apiModelId,
        max_tokens: maxOutputTokens(req.maxOutputChars),
        messages: [{ role: "user", content: req.prompt }],
      },
      req.signal,
      LABEL,
    )) as ChatCompletionsResponse;

    const cacheRead = data.usage?.prompt_tokens_details?.cached_tokens;
    const cacheWrite = data.usage?.prompt_tokens_details?.cache_write_tokens;
    return {
      text: requireText(
        (data.choices?.[0]?.message?.content ?? "").trim(),
        LABEL,
        data.choices?.[0]?.finish_reason,
      ),
      // prompt_tokens counts the cached portion too; DirectCallResult is disjoint.
      inputTokens: uncachedInput(data.usage?.prompt_tokens, cacheRead, cacheWrite),
      outputTokens: data.usage?.completion_tokens,
      cacheReadTokens: cacheRead,
      cacheCreateTokens: cacheWrite,
    };
  };
}
