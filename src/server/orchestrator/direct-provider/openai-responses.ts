import { DIRECT_CALL_PATHS, joinEndpoint } from "../../shared/catalogue/index.js";
import { maxOutputTokens, postJson, requireText, uncachedInput } from "./http.js";
import { DirectCallError, type DirectCall } from "./types.js";

const LABEL = "OpenAI Responses";

/**
 * Headroom, not a measurement. This style bills reasoning against the same cap
 * as the answer, so a text-sized budget can be spent before a word is written.
 * Correctness does not rest on the number: a cap that still runs out now ends
 * as an error rather than as an empty success.
 */
const REASONING_ALLOWANCE_TOKENS = 4096;

/** The API's own terminal failures; an unknown status is left to the gateway. */
const FAILED_STATUSES = new Set(["incomplete", "failed"]);

interface ResponsesResponse {
  output?: { type: string; content?: { type: string; text?: string }[] }[];
  status?: string;
  incomplete_details?: { reason?: string };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  };
}

/**
 * Reasoning items share the output array with the answer, so read only
 * `output_text` blocks of `message` items.
 */
export function createOpenAiResponsesCall(fetchImpl: typeof fetch = fetch): DirectCall {
  return async (req) => {
    const data = (await postJson(
      fetchImpl,
      joinEndpoint(req.baseUrl, DIRECT_CALL_PATHS["openai-responses"]),
      { Authorization: `Bearer ${req.apiKey}`, ...req.headers },
      {
        model: req.apiModelId,
        max_output_tokens: maxOutputTokens(req.maxOutputChars, REASONING_ALLOWANCE_TOKENS),
        input: req.prompt,
      },
      req.signal,
      LABEL,
    )) as ResponsesResponse;

    // A run that stopped early can answer 200 with partial text or none at all,
    // which is indistinguishable from a short complete answer.
    if (data.status !== undefined && FAILED_STATUSES.has(data.status)) {
      throw new DirectCallError(
        502,
        `${LABEL} did not complete: ${data.status}${
          data.incomplete_details?.reason ? ` (${data.incomplete_details.reason})` : ""
        }`,
      );
    }

    const text = (data.output ?? [])
      .filter((item) => item.type === "message")
      .flatMap((item) => item.content ?? [])
      .filter((block) => block.type === "output_text")
      .map((block) => block.text ?? "")
      .join("")
      .trim();
    const cacheRead = data.usage?.input_tokens_details?.cached_tokens;
    const cacheWrite = data.usage?.input_tokens_details?.cache_write_tokens;
    return {
      text: requireText(text, LABEL, data.status),
      // input_tokens counts both cache portions; DirectCallResult is disjoint.
      inputTokens: uncachedInput(data.usage?.input_tokens, cacheRead, cacheWrite),
      outputTokens: data.usage?.output_tokens,
      cacheReadTokens: cacheRead,
      cacheCreateTokens: cacheWrite,
    };
  };
}
