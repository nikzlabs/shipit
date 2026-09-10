import { buildCleanupPrompt } from "../cleanup-prompt.js";
import { VoiceProviderError, type CleanupOptions, type CleanupProvider } from "./types.js";

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const CLEANUP_MODEL = "gpt-4o-mini";

export function createOpenAiCleanupProvider(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): CleanupProvider {
  return {
    id: "openai-cleanup",
    async clean(rawTranscript: string, opts: CleanupOptions): Promise<string> {
      let res: Response;
      try {
        res = await fetchImpl(OPENAI_CHAT_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          ...(opts.signal ? { signal: opts.signal } : {}),
          body: JSON.stringify({
            model: CLEANUP_MODEL,
            temperature: 0,
            messages: [{ role: "user", content: buildCleanupPrompt(rawTranscript) }],
          }),
        });
      } catch (err) {
        throw new VoiceProviderError(502, `OpenAI cleanup request failed: ${(err as Error).message}`);
      }

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new VoiceProviderError(res.status, `OpenAI cleanup returned ${res.status}: ${detail.slice(0, 500)}`);
      }

      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return (data.choices?.[0]?.message?.content ?? "").trim();
    },
  };
}
