import { buildCleanupPrompt } from "../cleanup-prompt.js";
import { VoiceProviderError, type CleanupOptions, type CleanupProvider } from "./types.js";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const CLEANUP_MODEL = "claude-haiku-4-5";
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

export function createClaudeCleanupProvider(
  oauthToken: string,
  fetchImpl: typeof fetch = fetch,
): CleanupProvider {
  return {
    id: "claude-oauth",
    async clean(rawTranscript: string, opts: CleanupOptions): Promise<string> {
      let res: Response;
      try {
        res = await fetchImpl(ANTHROPIC_MESSAGES_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${oauthToken}`,
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "oauth-2025-04-20",
            "Content-Type": "application/json",
          },
          ...(opts.signal ? { signal: opts.signal } : {}),
          body: JSON.stringify({
            model: CLEANUP_MODEL,
            max_tokens: 1024,
            system: CLAUDE_CODE_IDENTITY,
            messages: [{ role: "user", content: buildCleanupPrompt(rawTranscript) }],
          }),
        });
      } catch (err) {
        throw new VoiceProviderError(502, `Claude cleanup request failed: ${(err as Error).message}`);
      }

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new VoiceProviderError(res.status, `Claude cleanup returned ${res.status}: ${detail.slice(0, 500)}`);
      }

      const data = (await res.json()) as { content?: { type: string; text?: string }[] };
      const text = (data.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("")
        .trim();
      return text;
    },
  };
}
