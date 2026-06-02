/**
 * redaction.ts — shared, two-stage redaction pipeline (docs/164).
 *
 * Scrubs free-text (an agent-composed bug-report body, and later a full
 * session export — docs/023) of secrets and PII *before* it is ever shown to
 * the user in the consent card or sent off the box. Two complementary stages:
 *
 *   Stage 1 — heuristic content scrubbing. Deterministic, unit-testable, and
 *   the GUARANTEED FLOOR. Replaces known-shape secrets/PII *substrings*
 *   (API-key prefixes, bearer tokens, JWTs, emails, credentialed/remote URLs,
 *   absolute workspace paths, long opaque tokens) with `[REDACTED]`.
 *
 *   Stage 2 — LLM semantic pass. Best-effort net for what Stage 1 can't see
 *   (a person's name, an internal hostname, a customer's data quoted in prose,
 *   a secret in a novel format). Runs orchestrator-side by invoking the
 *   session's own agent CLI as a one-shot prompt — the `session-namer.ts`
 *   pattern — so it reuses the session's model/credentials and is
 *   provider-agnostic across Claude and Codex. SPAN-BASED: the model returns
 *   the substrings it judges sensitive and *our code* applies the replacement;
 *   the model never returns rewritten text, so it cannot inject content into a
 *   payload filed under the user's name. On any failure (CLI error, timeout,
 *   unparseable output, or a span the model invented that isn't in the text)
 *   we degrade to the Stage-1 floor and signal `stage2Ran: false` so the card
 *   can flag it.
 *
 * Neither stage is a substitute for the human confirming the exact payload in
 * the card — they only shrink what the user must catch.
 */

import { execFile } from "node:child_process";
import type { AgentId } from "../../shared/types.js";
import { stripUrlCredentials } from "../git-utils.js";

export const REDACTION_PLACEHOLDER = "[REDACTED]";

/**
 * Ordered Stage-1 content patterns. Order matters: specific, high-signal
 * shapes (key prefixes, JWTs, credentialed URLs) run before the generic
 * long-token sweep so the readable `[REDACTED]` lands on the smallest correct
 * span rather than a greedy match swallowing surrounding text.
 *
 * Every entry matches a *substring* of free text — these are content patterns,
 * NOT the path-shaped `REDACTED_PATTERNS` in `shipit-source.ts` (which decide
 * whether a whole file may be referenced and would be a no-op here).
 */
const STAGE1_PATTERNS: { name: string; re: RegExp }[] = [
  // Provider API-key shapes. Anthropic (`sk-ant-…`) must precede the generic
  // OpenAI `sk-…` so the longer, more specific token is what gets reported.
  { name: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{12,}/g },
  { name: "openai-key", re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  // GitHub tokens: classic PATs (ghp_), OAuth (gho_), user/server/refresh
  // (ghu_/ghs_/ghr_), and fine-grained PATs (github_pat_…).
  { name: "github-token", re: /\b(?:gh[posur]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/g },
  // AWS access key ids.
  { name: "aws-key", re: /\b(?:AKIA|ASIA)[A-Z0-9]{12,}/g },
  // Google API keys.
  { name: "google-key", re: /\bAIza[A-Za-z0-9_-]{20,}/g },
  // Slack tokens.
  { name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{8,}/g },
  // JSON Web Tokens (three base64url segments).
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g },
  // Bearer / token / authorization headers carrying a secret value.
  { name: "bearer", re: /\b(?:Bearer|Token)\s+[A-Za-z0-9._~+/=-]{12,}/gi },
  // Email addresses.
  { name: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  // SSH git remotes (`git@github.com:owner/repo.git`).
  { name: "ssh-remote", re: /\b[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+\.git\b/g },
  // Absolute workspace / container paths that can leak a project name or a
  // user's home directory. Matches the path token up to whitespace.
  { name: "workspace-path", re: /(?:\/workspace|\/uploads|\/home\/[^\s/]+|\/root|\/Users\/[^\s/]+)\/[^\s)'"`]*/g },
];

/**
 * URLs are handled out-of-band from the regex table: a URL with embedded
 * credentials is always redacted, and a plain http(s)/git URL is collapsed to
 * `[REDACTED]` too because in a ShipIt-bug context the only URLs in the body
 * are almost always the user's own project remote (which we never want to
 * ship). `stripUrlCredentials` is reused so a credentialed URL never even
 * transiently appears in a log line during processing.
 */
const URL_RE = /\b(?:https?|git|ssh):\/\/[^\s)'"`]+/gi;

export interface Stage1Result {
  text: string;
  /** Number of substrings replaced — diagnostic only, not shown to the user. */
  redactedCount: number;
}

/**
 * Stage 1 — deterministic heuristic scrub. Pure function, no I/O. This is the
 * guaranteed floor: whatever Stage 2 does or doesn't do, the shapes below are
 * already gone.
 */
export function redactStage1(input: string): Stage1Result {
  let count = 0;
  let text = input;

  // URLs first — strip any embedded credentials (so we never log them) and
  // then collapse the whole URL.
  text = text.replace(URL_RE, (match) => {
    // Touch stripUrlCredentials so a credentialed URL is normalized before we
    // discard it; the return value is intentionally dropped.
    void stripUrlCredentials(match);
    count++;
    return REDACTION_PLACEHOLDER;
  });

  for (const { re } of STAGE1_PATTERNS) {
    text = text.replace(re, () => {
      count++;
      return REDACTION_PLACEHOLDER;
    });
  }

  // Generic long opaque tokens (40+ chars of token alphabet) — catches
  // high-entropy secrets in novel formats. Runs last so the specific patterns
  // above claim their matches first. Skips anything already redacted.
  text = text.replace(/\b[A-Za-z0-9_-]{40,}\b/g, (match) => {
    if (match === REDACTION_PLACEHOLDER) return match;
    count++;
    return REDACTION_PLACEHOLDER;
  });

  return { text, redactedCount: count };
}

/** A function that runs a one-shot prompt against the session's agent CLI. */
export type ModelRunner = (prompt: string) => Promise<string | null>;

export interface RedactResult {
  /** Fully scrubbed body (Stage 1 floor, plus Stage 2 spans when it ran). */
  body: string;
  /** True only if the Stage-2 semantic pass completed and was applied. */
  stage2Ran: boolean;
}

/**
 * Guard against a pathologically large body driving the model call. Stage 1 is
 * unaffected (it's local); this only bounds the Stage-2 prompt.
 */
const STAGE2_MAX_CHARS = 24_000;

const STAGE2_PROMPT_TEMPLATE = `You are a privacy redaction reviewer. The text below has already had known secret shapes removed. Your job is to find any REMAINING sensitive content a human reviewer might miss: people's names, internal hostnames, customer or third-party data quoted in prose, physical addresses, phone numbers, or secrets in an unusual format.

Return ONLY a JSON object of the exact substrings to redact, copied VERBATIM from the text (no paraphrasing, no rewriting). Use this shape with no markdown fences:
{"spans": ["exact substring 1", "exact substring 2"]}

If nothing else needs redacting, return {"spans": []}. Do NOT return rewritten text. Do NOT add commentary.

TEXT:
"""
{TEXT}
"""`;

/**
 * Run the Stage-2 LLM pass. Returns the spans the model wants redacted, or
 * `null` on any failure (so the caller degrades to the Stage-1 floor). The
 * model's output is parsed for a `{"spans": [...]}` object and each span is
 * verified to be an actual substring of `text` — a span the model invented
 * (an addition/rewrite rather than a deletion) is dropped, so the model can
 * never inject content.
 */
async function runStage2(text: string, run: ModelRunner): Promise<string[] | null> {
  if (text.length > STAGE2_MAX_CHARS) return null;
  const prompt = STAGE2_PROMPT_TEMPLATE.replace("{TEXT}", text);
  let raw: string | null;
  try {
    raw = await run(prompt);
  } catch {
    return null;
  }
  if (!raw) return null;

  const jsonMatch = /\{[\s\S]*"spans"[\s\S]*\}/.exec(raw);
  if (!jsonMatch) return null;
  let parsed: { spans?: unknown };
  try {
    parsed = JSON.parse(jsonMatch[0]) as { spans?: unknown };
  } catch {
    return null;
  }
  if (!Array.isArray(parsed.spans)) return null;

  // Deletions only: keep non-empty string spans that actually occur in the
  // text. Anything else (non-string, empty, or a span not present verbatim)
  // is discarded — the model cannot add or rewrite content.
  return parsed.spans.filter(
    (s): s is string => typeof s === "string" && s.length > 0 && text.includes(s),
  );
}

/** Escape a string for safe use as a literal inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Full two-stage redaction. Stage 1 always runs and is the floor; Stage 2 runs
 * only when a `ModelRunner` is supplied and succeeds. `stage2Ran` tells the
 * caller whether the semantic net actually ran so the consent card can flag a
 * miss.
 */
export async function redact(
  input: string,
  options: { agentId?: AgentId; run?: ModelRunner } = {},
): Promise<RedactResult> {
  const stage1 = redactStage1(input);
  const run = options.run ?? (options.agentId ? makeCliRunner(options.agentId) : undefined);
  if (!run) {
    return { body: stage1.text, stage2Ran: false };
  }

  const spans = await runStage2(stage1.text, run);
  if (spans === null) {
    // Fail safe — Stage 1 stands, flag the miss.
    return { body: stage1.text, stage2Ran: false };
  }

  let body = stage1.text;
  for (const span of spans) {
    body = body.replace(new RegExp(escapeRegExp(span), "g"), REDACTION_PLACEHOLDER);
  }
  return { body, stage2Ran: true };
}

/**
 * Default `ModelRunner`: invoke the locally installed provider CLI in
 * non-interactive mode, exactly like `session-namer.ts`. HOME is forced so the
 * CLI finds its credentials under the shared mount; we run from `/tmp` as a
 * one-shot prompt unrelated to any repo. Returns `null` on any failure.
 */
/**
 * Map an agent to its non-interactive CLI invocation. Mirrors
 * `session-namer.ts`'s `callAgentCli`: a `switch` (not an `agentId === …`
 * comparison) keeps this within the agent-abstraction lint rule — each branch
 * is a genuine per-CLI-shape exception (different binary + flags).
 */
function cliInvocation(agentId: AgentId, prompt: string): [string, string[]] {
  switch (agentId) {
    case "codex":
      // Run from /tmp (a one-shot prompt unrelated to any repo). Codex >=0.130
      // refuses `exec` outside a trusted git repo unless this flag is passed.
      return ["codex", ["exec", "--skip-git-repo-check", prompt]];
    case "claude":
    default:
      return ["claude", ["-p", prompt, "--output-format", "text"]];
  }
}

export function makeCliRunner(agentId: AgentId): ModelRunner {
  return (prompt: string) =>
    new Promise<string | null>((resolve) => {
      const [binary, args] = cliInvocation(agentId, prompt);

      let settled = false;
      const finish = (value: string | null): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      try {
        const child = execFile(
          binary,
          [...args],
          {
            timeout: 20_000,
            cwd: "/tmp",
            env: { ...process.env, HOME: process.env.HOME ?? "/root" },
            maxBuffer: 1024 * 1024,
          },
          (error, stdout) => {
            if (error) {
              finish(null);
              return;
            }
            finish(typeof stdout === "string" ? stdout : null);
          },
        );
        child.stdin?.end();
        child.on("error", () => finish(null));
      } catch {
        finish(null);
      }
    });
}
