import type { UtilityModelConfig } from "./credential-store.js";

export interface SessionName {
  slug: string;
  title: string;
}

const PROMPT_TEMPLATE = `Given this user message for a coding session, generate:
1. A short branch-friendly slug (lowercase, hyphens only, no special chars, max 40 chars)
2. A human-readable session title (max 60 chars)

User message: "{MESSAGE}"

Respond with ONLY valid JSON, no markdown fences: {"slug": "...", "title": "..."}`;

/**
 * Call a utility model API to generate a session title and branch-friendly
 * slug from the user's first message. Returns null on failure.
 */
export async function generateSessionName(
  userMessage: string,
  config: UtilityModelConfig,
): Promise<SessionName | null> {
  const truncated = userMessage.slice(0, 200);
  const prompt = PROMPT_TEMPLATE.replace("{MESSAGE}", truncated);

  try {
    const text = config.provider === "anthropic"
      ? await callAnthropic(config, prompt)
      : await callOpenAICompatible(config, prompt);

    if (!text) return null;

    const jsonMatch = text.match(/\{[^}]*"slug"\s*:\s*"[^"]*"[^}]*"title"\s*:\s*"[^"]*"[^}]*\}/);
    if (!jsonMatch) {
      console.warn("[session-namer] No JSON found in response:", text.slice(0, 200));
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]) as { slug?: string; title?: string };
    const slug = typeof parsed.slug === "string"
      ? parsed.slug.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40)
      : null;
    const title = typeof parsed.title === "string"
      ? parsed.title.slice(0, 60)
      : null;

    if (slug && title) return { slug, title };
    console.warn("[session-namer] Invalid parsed result:", parsed);
    return null;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      console.warn("[session-namer] Request timed out");
    } else {
      console.warn("[session-namer] Error:", err instanceof Error ? err.message : err);
    }
    return null;
  }
}

async function callOpenAICompatible(config: UtilityModelConfig, prompt: string): Promise<string | null> {
  const baseUrl = (config.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 128,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: controller.signal,
  });

  clearTimeout(timeout);

  if (!res.ok) {
    console.warn("[session-namer] OpenAI-compatible API error:", res.status, await res.text().catch(() => ""));
    return null;
  }

  const body = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  return body.choices?.[0]?.message?.content ?? null;
}

async function callAnthropic(config: UtilityModelConfig, prompt: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 128,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: controller.signal,
  });

  clearTimeout(timeout);

  if (!res.ok) {
    console.warn("[session-namer] Anthropic API error:", res.status, await res.text().catch(() => ""));
    return null;
  }

  const body = await res.json() as { content?: Array<{ type: string; text?: string }> };
  return body.content?.find((b) => b.type === "text")?.text ?? null;
}
