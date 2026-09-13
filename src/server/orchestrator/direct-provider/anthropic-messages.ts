import { DIRECT_CALL_PATHS, joinEndpoint } from "../../shared/catalogue/index.js";
import { maxOutputTokens, postJson } from "./http.js";
import type { DirectCall } from "./types.js";

const ANTHROPIC_VERSION = "2023-06-01";

interface MessagesResponse {
  content?: { type: string; text?: string }[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/**
 * `x-api-key` rather than a bearer token: measured 2026-09-13 to reach
 * authentication on every base that carries this style — Anthropic, DeepSeek's
 * /anthropic, Z.ai, OpenRouter and OpenCode Zen, the last of which answers
 * "Missing API key" to a bearer token.
 */
export function createAnthropicMessagesCall(fetchImpl: typeof fetch = fetch): DirectCall {
  return async (req) => {
    const data = (await postJson(
      fetchImpl,
      joinEndpoint(req.baseUrl, DIRECT_CALL_PATHS["anthropic-messages"]),
      {
        "x-api-key": req.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        ...req.headers,
      },
      {
        model: req.apiModelId,
        max_tokens: maxOutputTokens(req.maxOutputChars),
        messages: [{ role: "user", content: req.prompt }],
      },
      req.signal,
      "Anthropic Messages",
    )) as MessagesResponse;

    const text = (data.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("")
      .trim();
    return {
      text,
      inputTokens: data.usage?.input_tokens,
      outputTokens: data.usage?.output_tokens,
      cacheReadTokens: data.usage?.cache_read_input_tokens,
      cacheCreateTokens: data.usage?.cache_creation_input_tokens,
    };
  };
}
