import { execFile } from "node:child_process";
import type { AgentId } from "../../shared/types.js";
import { stripUrlCredentials } from "../git-utils.js";

export const REDACTION_PLACEHOLDER = "[REDACTED]";

const STAGE1_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{12,}/g },
  { name: "openai-key", re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { name: "github-token", re: /\b(?:gh[posur]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { name: "aws-key", re: /\b(?:AKIA|ASIA)[A-Z0-9]{12,}/g },
  { name: "google-key", re: /\bAIza[A-Za-z0-9_-]{20,}/g },
  { name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{8,}/g },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g },
  { name: "bearer", re: /\b(?:Bearer|Token)\s+[A-Za-z0-9._~+/=-]{12,}/gi },
  { name: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { name: "ssh-remote", re: /\b[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+\.git\b/g },
  { name: "workspace-path", re: /(?:\/workspace|\/uploads|\/home\/[^\s/]+|\/root|\/Users\/[^\s/]+)\/[^\s)'"`]*/g },
];

// Plain URLs can disclose private project remotes too.
const URL_RE = /\b(?:https?|git|ssh):\/\/[^\s)'"`]+/gi;

export interface Stage1Result {
  text: string;
  redactedCount: number;
}

export function redactStage1(input: string): Stage1Result {
  let count = 0;
  let text = input;

  text = text.replace(URL_RE, (match) => {
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

  // Specific patterns must claim their spans before this generic token sweep.
  text = text.replace(/\b[A-Za-z0-9_-]{40,}\b/g, (match) => {
    if (match === REDACTION_PLACEHOLDER) return match;
    count++;
    return REDACTION_PLACEHOLDER;
  });

  return { text, redactedCount: count };
}

export type ModelRunner = (prompt: string) => Promise<string | null>;

export interface RedactResult {
  body: string;
  stage2Ran: boolean;
}

const STAGE2_MAX_CHARS = 24_000;

const STAGE2_PROMPT_TEMPLATE = `You are a privacy redaction reviewer. The text below has already had known secret shapes removed. Your job is to find any REMAINING sensitive content a human reviewer might miss: people's names, internal hostnames, customer or third-party data quoted in prose, physical addresses, phone numbers, or secrets in an unusual format.

Return ONLY a JSON object of the exact substrings to redact, copied VERBATIM from the text (no paraphrasing, no rewriting). Use this shape with no markdown fences:
{"spans": ["exact substring 1", "exact substring 2"]}

If nothing else needs redacting, return {"spans": []}. Do NOT return rewritten text. Do NOT add commentary.

TEXT:
"""
{TEXT}
"""`;

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

  // Accept deletions only; the model cannot insert content into the report.
  return parsed.spans.filter(
    (s): s is string => typeof s === "string" && s.length > 0 && text.includes(s),
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
    return { body: stage1.text, stage2Ran: false };
  }

  let body = stage1.text;
  for (const span of spans) {
    body = body.replace(new RegExp(escapeRegExp(span), "g"), REDACTION_PLACEHOLDER);
  }
  return { body, stage2Ran: true };
}

function cliInvocation(agentId: AgentId, prompt: string): [string, string[]] {
  switch (agentId) {
    case "codex":
      // The working directory is /tmp, outside a trusted repository.
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
