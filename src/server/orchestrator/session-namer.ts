import { execFile } from "node:child_process";
import path from "node:path";
import type { AgentId } from "../shared/types.js";
import { isHarnessInstalled } from "../shared/installed-harnesses.js";
import { ensureCodexHomeInitialized } from "./agents/codex/home-init.js";

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
  /**
   * docs/150 — credential root (provider-account directory) the naming CLI
   * should read, i.e. the account this naming call is billed against.
   *
   * Omitted means the singleton root, which resolves through the legacy alias
   * symlink to the *migrated default* account — so naming ran on
   * `claude-default` no matter which account was primary, and broke outright
   * once that account was disconnected. Callers that know the route pass it;
   * see `graduateSession`.
   */
  credentialRoot?: string,
): Promise<SessionName | null> {
  // docs/252 phase 9 (req 14) — naming runs on the ORCHESTRATOR's own CLIs, not in
  // the session container, so a deployment that did not install this harness has
  // nothing to shell out to. Skip explicitly rather than spawning a missing binary
  // and reading the failure back out of stderr; `null` is already "keep the
  // placeholder title", so the surrounding operation is unaffected.
  if (!isHarnessInstalled(agentId)) {
    console.warn(`[session-namer] ${agentId} is not installed in this deployment; skipping naming`);
    return null;
  }

  const truncated = userMessage.slice(0, 200);
  const prompt = PROMPT_TEMPLATE.replace("{MESSAGE}", truncated);

  try {
    const text = await callAgentCli(agentId, prompt, credentialRoot);
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

async function callAgentCli(agentId: AgentId, prompt: string, credentialRoot?: string): Promise<string | null> {
  switch (agentId) {
    case "claude":
      return callCli("claude", ["-p", prompt, "--output-format", "text"], agentId, credentialRoot);
    case "codex":
      // Naming is one of the two `codex` processes that start against the same
      // config root on a session's first message — the other is the turn's own
      // agent — and Codex's first-run initialization of that root is not
      // concurrency-safe, so whichever loses exits 1 before doing any work. Both
      // spawners await the same gate, which initializes a cold root exactly once
      // and is a directory read thereafter. See `agents/codex/home-init.ts`.
      //
      // Awaited BEFORE the spawn, not around it: the point is to be the only
      // process in the root while it is cold, not to serialize naming against
      // turns generally.
      if (credentialRoot) await ensureCodexHomeInitialized(path.join(credentialRoot, ".codex"));
      // We run from /tmp (a one-shot prompt unrelated to any repo). Codex >=0.130
      // refuses `exec` outside a trusted git repo unless this flag is passed.
      return callCli("codex", ["exec", "--skip-git-repo-check", prompt], agentId, credentialRoot);
  }
}

/**
 * Invoke the locally installed provider CLI in non-interactive mode.
 *
 * HOME selects the credentials: a provider-account root when the caller
 * resolved one (docs/150 — the account layout mirrors `$HOME`, which is the
 * same trick the scoped auth flows use), else `/root` for the singleton mount.
 * We do not pass resume/thread flags; this is a one-shot prompt unrelated to
 * the coding conversation.
 */
function callCli(
  binary: string,
  args: string[],
  agentId: AgentId,
  credentialRoot?: string,
): Promise<string | null> {
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
          env: { ...process.env, HOME: credentialRoot ?? process.env.HOME ?? "/root" },
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
