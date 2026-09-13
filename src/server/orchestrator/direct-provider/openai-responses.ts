import { DIRECT_CALL_PATHS, joinEndpoint } from "../../shared/catalogue/index.js";
import { maxOutputTokens, postJson } from "./http.js";
import type { DirectCall } from "./types.js";

interface ResponsesResponse {
  output?: { type: string; content?: { type: string; text?: string }[] }[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
  };
}

/**
 * Reasoning items share the output array with the answer, so read only
 * `output_text` blocks of `message` items. No cache-write count exists here:
 * this style's caching is automatic and unbilled as a write.
 */
export function createOpenAiResponsesCall(fetchImpl: typeof fetch = fetch): DirectCall {
  return async (req) => {
    const data = (await postJson(
      fetchImpl,
      joinEndpoint(req.baseUrl, DIRECT_CALL_PATHS["openai-responses"]),
      { Authorization: `Bearer ${req.apiKey}`, ...req.headers },
      {
        model: req.apiModelId,
        max_output_tokens: maxOutputTokens(req.maxOutputChars),
        input: req.prompt,
      },
      req.signal,
      "OpenAI Responses",
    )) as ResponsesResponse;

    const text = (data.output ?? [])
      .filter((item) => item.type === "message")
      .flatMap((item) => item.content ?? [])
      .filter((block) => block.type === "output_text")
      .map((block) => block.text ?? "")
      .join("")
      .trim();
    return {
      text,
      inputTokens: data.usage?.input_tokens,
      outputTokens: data.usage?.output_tokens,
      cacheReadTokens: data.usage?.input_tokens_details?.cached_tokens,
    };
  };
}
