import { execFile } from "node:child_process";

export interface SessionName {
  slug: string;
  title: string;
}

/**
 * Spawn a short-lived Claude CLI process to generate a session title and
 * branch-friendly slug from the user's first message. Returns null on failure.
 */
export function generateSessionName(userMessage: string, cwd?: string): Promise<SessionName | null> {
  const truncated = userMessage.slice(0, 200);
  const prompt = `Given this user message for a coding session, generate:
1. A short branch-friendly slug (lowercase, hyphens only, no special chars, max 40 chars)
2. A human-readable session title (max 60 chars)

User message: "${truncated}"

Respond with ONLY valid JSON, no markdown fences: {"slug": "...", "title": "..."}`;

  return new Promise((resolve) => {
    try {
      const child = execFile(
        "claude",
        ["-p", prompt, "--output-format", "text"],
        {
          timeout: 15_000,
          cwd: cwd ?? "/tmp",
          env: { ...process.env, HOME: "/root" },
        },
        (error, stdout) => {
          if (error) {
            console.warn("[session-namer] CLI failed:", error.message);
            resolve(null);
            return;
          }

          try {
            // Extract JSON from response (strip any surrounding text)
            const jsonMatch = stdout.match(/\{[^}]*"slug"\s*:\s*"[^"]*"[^}]*"title"\s*:\s*"[^"]*"[^}]*\}/);
            if (!jsonMatch) {
              console.warn("[session-namer] No JSON found in response:", stdout.slice(0, 200));
              resolve(null);
              return;
            }

            const parsed = JSON.parse(jsonMatch[0]) as { slug?: string; title?: string };
            const slug = typeof parsed.slug === "string"
              ? parsed.slug.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40)
              : null;
            const title = typeof parsed.title === "string"
              ? parsed.title.slice(0, 60)
              : null;

            if (slug && title) {
              resolve({ slug, title });
            } else {
              console.warn("[session-namer] Invalid parsed result:", parsed);
              resolve(null);
            }
          } catch (parseErr) {
            console.warn("[session-namer] Parse error:", parseErr);
            resolve(null);
          }
        },
      );

      // Safety: kill if the process hangs
      child.on("error", (err) => {
        console.warn("[session-namer] Process error:", err.message);
        resolve(null);
      });
    } catch (err) {
      console.warn("[session-namer] Spawn error:", err);
      resolve(null);
    }
  });
}
