import { DIRECT_CALL_PATHS, joinEndpoint } from "../../shared/catalogue/index.js";
import { maxOutputTokens, postJson } from "./http.js";
import type { DirectCall } from "./types.js";

interface ChatCompletionsResponse {
  choices?: { message?: { content?: string } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
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
      "OpenAI Chat Completions",
    )) as ChatCompletionsResponse;

    return {
      text: (data.choices?.[0]?.message?.content ?? "").trim(),
      inputTokens: data.usage?.prompt_tokens,
      outputTokens: data.usage?.completion_tokens,
      cacheReadTokens: data.usage?.prompt_tokens_details?.cached_tokens,
    };
  };
}
