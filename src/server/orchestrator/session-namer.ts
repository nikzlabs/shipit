import { execFile } from "node:child_process";
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
    let text: string | null;
    switch (config.provider) {
      case "anthropic":
        text = await callAnthropic(config, prompt);
        break;
      case "claude-cli":
        text = await callClaudeCli(prompt);
        break;
      default:
        text = await callOpenAICompatible(config, prompt);
    }

    if (!text) return null;

    const jsonMatch = /\{[^}]*"slug"\s*:\s*"[^"]*"[^}]*"title"\s*:\s*"[^"]*"[^}]*\}/.exec(text);
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
  if (!config.apiKey) {
    console.warn("[session-namer] OpenAI-compatible provider requires an apiKey");
    return null;
  }
  const baseUrl = (config.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");

  for (const tokenParam of ["max_completion_tokens", "max_tokens"] as const) {
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
        [tokenParam]: 128,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (res.status === 400) {
      const body = await res.text().catch(() => "");
      if (body.includes("max_tokens") || body.includes("max_completion_tokens")) {
        continue; // try the other parameter
      }
      console.warn("[session-namer] OpenAI-compatible API error:", 400, body);
      return null;
    }

    if (!res.ok) {
      console.warn("[session-namer] OpenAI-compatible API error:", res.status, await res.text().catch(() => ""));
      return null;
    }

    const body = await res.json() as { choices?: { message?: { content?: string } }[] };
    return body.choices?.[0]?.message?.content ?? null;
  }

  console.warn("[session-namer] Both max_completion_tokens and max_tokens rejected by model:", config.model);
  return null;
}

async function callAnthropic(config: UtilityModelConfig, prompt: string): Promise<string | null> {
  if (!config.apiKey) {
    console.warn("[session-namer] Anthropic provider requires an apiKey");
    return null;
  }
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

  const body = await res.json() as { content?: { type: string; text?: string }[] };
  return body.content?.find((b) => b.type === "text")?.text ?? null;
}

/**
 * Invoke the locally installed Claude Code CLI in non-interactive mode.
 *
 * Uses the same OAuth credentials the agent uses (mounted at /root/.claude
 * via the credentials volume), so no separate API key is required.
 *
 * Implementation notes — these were the cause of the previous "fails silently
 * in containers" bug:
 *   - `stdio: ["ignore", "pipe", "pipe"]` is critical. With piped (but unwritten)
 *     stdin the CLI prints `Warning: no stdin data received in 3s, proceeding
 *     without it` to stderr after waiting 3 seconds, which ate ~20% of our
 *     15s timeout budget for no reason.
 *   - HOME is forced to /root so the CLI finds /root/.claude (the symlink to
 *     the shared /credentials/.claude volume).
 *   - We do NOT pass --resume or any session flag — this is a one-shot prompt.
 */
function callClaudeCli(prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    try {
      const child = execFile(
        "claude",
        ["-p", prompt, "--output-format", "text"],
        {
          timeout: 15_000,
          cwd: "/tmp",
          env: { ...process.env, HOME: process.env.HOME ?? "/root" },
          maxBuffer: 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error) {
            const stderrTail = typeof stderr === "string" ? stderr.slice(-200).trim() : "";
            console.warn(
              "[session-namer] Claude CLI failed:",
              error.message,
              stderrTail ? `stderr=${stderrTail}` : "",
            );
            finish(null);
            return;
          }
          finish(typeof stdout === "string" ? stdout : null);
        },
      );

      // Detach stdin so the CLI doesn't sit waiting for piped input.
      child.stdin?.end();

      child.on("error", (err) => {
        console.warn("[session-namer] Claude CLI spawn error:", err.message);
        finish(null);
      });
    } catch (err) {
      console.warn("[session-namer] Claude CLI exception:", err instanceof Error ? err.message : err);
      finish(null);
    }
  });
}
