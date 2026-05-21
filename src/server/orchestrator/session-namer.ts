import { execFile } from "node:child_process";
import type { AgentId } from "../shared/types.js";

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
 * Generate a session title and branch-friendly slug from the user's first message.
 *
 * Shells out to the locally installed CLI for the session's active agent, using
 * the same credentials as that agent. Returns `null` on any failure (network
 * error, parse error, CLI missing/unauthenticated).
 * Callers must treat `null` as "skip the rename" rather than retry, so naming is
 * silently best-effort and never blocks session graduation.
 */
export async function generateSessionName(
  userMessage: string,
  agentId: AgentId,
): Promise<SessionName | null> {
  const truncated = userMessage.slice(0, 200);
  const prompt = PROMPT_TEMPLATE.replace("{MESSAGE}", truncated);

  try {
    const text = await callAgentCli(agentId, prompt);
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
    console.warn("[session-namer] Error:", err instanceof Error ? err.message : err);
    return null;
  }
}

function callAgentCli(agentId: AgentId, prompt: string): Promise<string | null> {
  switch (agentId) {
    case "claude":
      return callCli("claude", ["-p", prompt, "--output-format", "text"], agentId);
    case "codex":
      return callCli("codex", ["exec", prompt], agentId);
  }
}

/**
 * Invoke the locally installed provider CLI in non-interactive mode.
 *
 * HOME is forced to /root so provider CLIs find their credential directories
 * under the shared credentials mount. We do not pass resume/thread flags; this
 * is a one-shot prompt unrelated to the coding conversation.
 */
function callCli(binary: string, args: string[], agentId: AgentId): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    try {
      const child = execFile(
        binary,
        args,
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
              `[session-namer] ${agentId} CLI failed:`,
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
        console.warn(`[session-namer] ${agentId} CLI spawn error:`, err.message);
        finish(null);
      });
    } catch (err) {
      console.warn(`[session-namer] ${agentId} CLI exception:`, err instanceof Error ? err.message : err);
      finish(null);
    }
  });
}
