import { execFile } from "node:child_process";
import type { AgentId } from "../../shared/types.js";
import { stripUrlCredentials } from "../git-utils.js";

export const REDACTION_PLACEHOLDER = "[REDACTED]";

const KEY_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{12,}/g },
  { name: "openai-key", re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { name: "github-token", re: /\b(?:gh[posur]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { name: "aws-key", re: /\b(?:AKIA|ASIA)[A-Z0-9]{12,}/g },
  { name: "google-key", re: /\bAIza[A-Za-z0-9_-]{20,}/g },
  { name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{8,}/g },
];

const STAGE1_PATTERNS: { name: string; re: RegExp }[] = [
  ...KEY_PATTERNS,
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

// A key block starts with its BEGIN line and then key text. The marker alone, as source code
// that handles keys quotes it, is not one. A block with no END line ends where key text ends.
const PRIVATE_KEY_BLOCK_RE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:\s|\\[nr])+(?=[A-Za-z0-9+/=]{16}|Proc-Type:)[A-Za-z0-9+/=\s\\:,-]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|(?![A-Za-z0-9+/=\s\\:,-]))/g;

// The Stage 1 JWT pattern needs seconds for 80 KB of `eyJ-eyJ-…`: it scans the run again from
// each `eyJ`. This one matches the same text. It looks at a run of token characters once, from
// its start, and takes the first `eyJ` in it that follows a word boundary.
const JWT_LINEAR_RE =
  /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6})((?:[A-Za-z0-9_]*-)*?)eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g;

// The password is all that is between the first `:` and the LAST `@` of the authority, so a
// password with an `@` in it leaves nothing. The authority ends at a character that a URL
// cannot hold, so a URL in JSON does not reach into the next field. The user name stays.
const URL_PASSWORD_RE =
  /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/[^\s/?#@:"<>\\`{}|^]*:)[^\s/?#"<>\\`{}|^]*@/gi;

// "Token documentation" is prose. A credential has a digit in it, or is long.
const AUTH_SCHEME_RE = /\b(Bearer|Token|Basic)(\s+)([A-Za-z0-9._~+/=-]{12,})/gi;

// An environment-style assignment, as `.env`, `export` and `docker inspect` print it.
const ASSIGNMENT_NAME_RE = /(?<![A-Za-z0-9_])([A-Z][A-Z0-9_]*)=/g;
const SECRET_NAME_RE = /SECRET|TOKEN(?!S)|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY/;
// A name with one of these endings holds a fact about the secret, not the secret.
const METADATA_NAME_RE =
  /_(?:FILE|PATH|DIR|URL|URI|ID|NAME|TYPE|TTL|EXPIRY|EXPIRES|TIMEOUT|LENGTH|COUNT|LIMIT|ENABLED)$/;
// A quote before `,` `]` `}` `)` or a line end closes a string AROUND the assignment.
const CLOSING_QUOTE = String.raw`["'](?:[,\]})]|[ \t]*(?:\r?\n|$))`;
const ASSIGNMENT_VALUE_RE = new RegExp(
  [
    // The assignment is inside a JSON string, so its quotes are `\"` and its backslashes `\\`.
    String.raw`\\"(?:\\\\(?:\\"|\\\\|\\[^"\\]|[^\\"])?|\\[^"\\]|[^\\"])*(?:\\"|"|\\?$)`,
    // One shell word: quoted parts and bare parts with no space between them. A quote that
    // never closes takes the rest of the text. A written-out `\n` ends a bare part.
    String.raw`(?:(?!${CLOSING_QUOTE})(?:'[^']*(?:'|$)|"(?:[^"\\]|\\[\s\S])*(?:"|\\?$)|\\[^nrt]|[^\s"'\\]))+`,
  ].join("|"),
  "y",
);
const QUOTED_PLACEHOLDER_RE = /^\\?["']?\[REDACTED\]\\?["']?$/;

// A scan, not one pattern: a pattern that finds the secret word in the name and then fails on
// the value tries the name again from each later secret word, which is quadratic.
function redactAssignments(text: string): Stage1Result {
  let out = "";
  let copied = 0;
  let count = 0;
  ASSIGNMENT_NAME_RE.lastIndex = 0;
  for (let name = ASSIGNMENT_NAME_RE.exec(text); name !== null; name = ASSIGNMENT_NAME_RE.exec(text)) {
    // The scan goes on INSIDE the value of a name that is not a secret: `OPTS="… X_TOKEN=…"`.
    if (!SECRET_NAME_RE.test(name[1]) || METADATA_NAME_RE.test(name[1])) continue;
    const valueStart = ASSIGNMENT_NAME_RE.lastIndex;
    ASSIGNMENT_VALUE_RE.lastIndex = valueStart;
    const value = ASSIGNMENT_VALUE_RE.exec(text);
    if (!value) continue;
    ASSIGNMENT_NAME_RE.lastIndex = ASSIGNMENT_VALUE_RE.lastIndex;
    // An earlier pattern already replaced the whole value.
    if (QUOTED_PLACEHOLDER_RE.test(value[0])) continue;
    out += `${text.slice(copied, valueStart)}${REDACTION_PLACEHOLDER}`;
    copied = ASSIGNMENT_VALUE_RE.lastIndex;
    count++;
  }
  return { text: out + text.slice(copied), redactedCount: count };
}

/**
 * Credential shapes only (docs/326-ops-session-transcript req 3): URLs, paths, e-mail
 * addresses and commit hashes stay readable. It matches by shape, so a secret in a format
 * that is not listed here passes.
 *
 * The input can be megabytes of text that another session wrote, and this runs on the
 * orchestrator's main thread. A pattern added here must not scan a run again from each of
 * its positions: `redaction.test.ts` times the hostile inputs.
 */
export function redactCredentials(input: string): Stage1Result {
  let count = 0;
  const replace = (): string => {
    count++;
    return REDACTION_PLACEHOLDER;
  };
  let text = input.replace(PRIVATE_KEY_BLOCK_RE, replace);
  text = text.replace(URL_PASSWORD_RE, (_match, prefix: string) => {
    count++;
    return `${prefix}${REDACTION_PLACEHOLDER}@`;
  });
  for (const { re } of KEY_PATTERNS) text = text.replace(re, replace);
  text = text.replace(AUTH_SCHEME_RE, (match, scheme: string, space: string, value: string) => {
    if (!/\d/.test(value) && value.length < 32) return match;
    count++;
    return `${scheme}${space}${REDACTION_PLACEHOLDER}`;
  });
  text = text.replace(JWT_LINEAR_RE, (_match, before: string) => {
    count++;
    return `${before}${REDACTION_PLACEHOLDER}`;
  });
  const assignments = redactAssignments(text);
  return { text: assignments.text, redactedCount: count + assignments.redactedCount };
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
