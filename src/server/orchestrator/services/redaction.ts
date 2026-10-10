import { execFile } from "node:child_process";
import type { AgentId } from "../../shared/types.js";

export const REDACTION_PLACEHOLDER = "[REDACTED]";

const KEY_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{12,}/g },
  { name: "openai-key", re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { name: "github-token", re: /\b(?:gh[posur]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { name: "aws-key", re: /\b(?:AKIA|ASIA)[A-Z0-9]{12,}/g },
  { name: "google-key", re: /\bAIza[A-Za-z0-9_-]{20,}/g },
  { name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{8,}/g },
];

// A pattern with `orRun` is `(shape)|rest of the run`. A shape that fails at one start fails at
// every later start in the same run, so the second alternative takes the run and the shape is
// tried once in it. With the shape alone, 80 KB of `a.a.a.…` needed 10 s (planning#677). A
// look-behind for the start of a run is not equal: a match can end in the middle of a run, and
// `a@b.cc.d@e.ff` is two matches. `orRun` is text that each match has in it: the second
// alternative costs a call for each run, so text with none of it is not scanned.
const STAGE1_PATTERNS: { name: string; re: RegExp; orRun?: string }[] = [
  ...KEY_PATTERNS,
  {
    name: "jwt",
    re: /(\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,})|\beyJ[A-Za-z0-9_-]*/g,
    orRun: "eyJ",
  },
  { name: "bearer", re: /\b(?:Bearer|Token)\s+[A-Za-z0-9._~+/=-]{12,}/gi },
  {
    name: "email",
    re: /(\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b)|\b[A-Za-z0-9._%+-]+/g,
    orRun: "@",
  },
  {
    name: "ssh-remote",
    re: /(\b[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+\.git\b)|\b[A-Za-z0-9._-]+/g,
    orRun: "@",
  },
  { name: "workspace-path", re: /(?:\/workspace|\/uploads|\/home\/[^\s/]+|\/root|\/Users\/[^\s/]+)\/[^\s)'"`]*/g },
];

// Plain URLs can disclose private project remotes too.
const URL_RE = /\b(?:https?|git|ssh):\/\/[^\s)'"`]+/gi;

// The last steps take an scp-style remote that the patterns above took in part or not at
// all. Those patterns stay as they are: a change there shows text that a later step hides
// (docs/164-user-bug-filing/plan.md). A path can hold placeholders of earlier steps, and it
// needs a `/` or `.git`: a port, a time or a word after a colon stays.
const SCP_PATH_PART = String.raw`(?:[A-Za-z0-9._-]|\[REDACTED\])`;
const SCP_PATH = String.raw`${SCP_PATH_PART}*\/(?:${SCP_PATH_PART}|\/)*`;
// `(shape)|rest of the run`, as in `STAGE1_PATTERNS`.
const SCP_REMOTE_RE = new RegExp(
  String.raw`(\b[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:${SCP_PATH})|\b[A-Za-z0-9._-]+`,
  "g",
);
// A host has no `[` in it and a path has no colon in it: no text is read again from each
// placeholder.
const SCP_PATH_AFTER_REDACTION_RE = new RegExp(
  String.raw`\[REDACTED\][A-Za-z0-9.-]*:(?:${SCP_PATH}|${SCP_PATH_PART}+\.git\b)`,
  "g",
);

export interface Stage1Result {
  text: string;
  redactedCount: number;
}

export function redactStage1(input: string): Stage1Result {
  let count = 0;
  let text = input;

  // The URL is not parsed: `new URL` is quadratic in a host of many different non-ASCII
  // characters.
  text = text.replace(URL_RE, () => {
    count++;
    return REDACTION_PLACEHOLDER;
  });

  for (const { re, orRun } of STAGE1_PATTERNS) {
    if (orRun !== undefined && !text.includes(orRun)) continue;
    text = text.replace(re, (match: string, shape: unknown) => {
      if (orRun !== undefined && shape === undefined) return match;
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

  // These two are last and only replace text: they cannot make redacted text visible.
  if (text.includes("@")) {
    text = text.replace(SCP_REMOTE_RE, (match: string, shape: unknown) => {
      if (shape === undefined) return match;
      count++;
      return REDACTION_PLACEHOLDER;
    });
  }
  // Not counted: it makes a redaction longer.
  text = text.replace(SCP_PATH_AFTER_REDACTION_RE, REDACTION_PLACEHOLDER);

  return { text, redactedCount: count };
}

type Span = [start: number, end: number];

// A key block starts with its BEGIN line and then key text: 16 base64 characters, with only
// line ends between them. The marker alone, as source code that handles keys quotes it, is
// not a block. A block with no END line ends where key text ends.
const PRIVATE_KEY_BLOCK_RE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:\s|\\[nr])+(?=(?:[A-Za-z0-9+/=](?:\r?\n|\\[nr])*){16}|Proc-Type:)[A-Za-z0-9+/=\s\\:,-]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|(?![A-Za-z0-9+/=\s\\:,-]))/g;

// The JWT shape of Stage 1 with no second alternative: group 1 of each match is a credential.
// It looks at a run of token characters once, from its start, and takes the first `eyJ` in it
// that follows a word boundary.
const JWT_LINEAR_RE =
  /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6})(?:[A-Za-z0-9_]*-)*?(eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,})/dg;

// The password is all that is between the first `:` and the LAST `@` of the authority, so a
// password with an `@` in it leaves nothing. The authority ends at a character that a URL
// cannot hold, or at a `'` that closes a string, so a URL with a port does not reach into the
// next field of JSON or of an object literal. The user name stays.
const URL_PASSWORD_RE =
  /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s/?#@:"'<>\\`{}|^]*:((?:[^\s/?#"'<>\\`{}|^]|'(?![,;)\]}\s]|$))*)@/dgi;

const AUTH_HEADER_RE = /\bAuthorization["']?\s*[:=]\s*["']?(?:Bearer|Token|Basic)\s+([^\s"',;]+)/dgi;
// With no header in front, "Token documentation" is prose. A heuristic: the value must have a
// digit in it or be 32 characters long, so a short value with no digit passes.
const AUTH_SCHEME_RE = /\b(?:Bearer|Token|Basic)\s+([A-Za-z0-9._~+/=-]{12,})/dgi;

// An environment-style assignment, as `.env`, `export` and `docker inspect` print it. `==` is
// a comparison.
const ASSIGNMENT_NAME_RE = /(?<![A-Za-z0-9_])([A-Z][A-Z0-9_]*)=(?!=)/g;
const SECRET_NAME_RE =
  /SECRET|TOKEN(?!S|IZER)|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY/;
// A name with one of these endings holds a fact about the secret, not the secret.
const METADATA_NAME_RE =
  /_(?:FILE|PATH|DIR|URL|URI|ID|NAME|TYPE|TTL|EXPIRY|EXPIRES|TIMEOUT|LENGTH|COUNT|LIMIT|ENABLED)$/;

// The value is one shell word: parts with no white space between them. No part can fail after
// a long scan: a quote that never closes takes the rest of the text.
const VALUE_PART = [
  // Inside a JSON string a quote is `\"` and a backslash is `\\`.
  String.raw`\\"(?:\\\\(?:\\"|\\\\|\\[^"\\]|[^\\"])?|\\[^"\\]|[^\\"])*(?:\\")?`,
  String.raw`\\\\[ \t]`,
  // A written-out `\n` ends the word: JSON text with line ends in it is common in a transcript.
  String.raw`\\[^n]`,
  String.raw`'[^']*'?`,
  String.raw`"(?:[^"\\]|\\[\s\S])*"?`,
  String.raw`[^\s"'\\]`,
].join("|");
// After the first part, a quote before `,` `]` `}` `)` or a line end closes a string AROUND
// the assignment, as in `["API_KEY=abc", "PATH=/bin"]`.
const CLOSING_QUOTE = String.raw`["'](?:[,\]})]|[ \t]*(?:\r?\n|$))`;
const ASSIGNMENT_VALUE_RE = new RegExp(`(?:${VALUE_PART})(?:(?!${CLOSING_QUOTE})(?:${VALUE_PART}))*`, "y");

// A scan, not one pattern: a pattern that finds the secret word in the name and then fails on
// the value tries the name again from each later secret word, which is quadratic.
function assignmentValueSpans(text: string, spans: Span[]): void {
  ASSIGNMENT_NAME_RE.lastIndex = 0;
  for (let name = ASSIGNMENT_NAME_RE.exec(text); name !== null; name = ASSIGNMENT_NAME_RE.exec(text)) {
    // The scan goes on INSIDE the value of a name that is not a secret: `OPTS="… X_TOKEN=…"`.
    if (!SECRET_NAME_RE.test(name[1]) || METADATA_NAME_RE.test(name[1])) continue;
    ASSIGNMENT_VALUE_RE.lastIndex = ASSIGNMENT_NAME_RE.lastIndex;
    if (ASSIGNMENT_VALUE_RE.exec(text) === null) continue;
    spans.push([ASSIGNMENT_NAME_RE.lastIndex, ASSIGNMENT_VALUE_RE.lastIndex]);
    ASSIGNMENT_NAME_RE.lastIndex = ASSIGNMENT_VALUE_RE.lastIndex;
  }
}

function matchSpans(
  text: string,
  re: RegExp,
  spans: Span[],
  group = 0,
  accept: (value: string) => boolean = () => true,
): void {
  for (const match of text.matchAll(re)) {
    const span = group === 0 ? [match.index, match.index + match[0].length] : match.indices?.[group];
    if (span && span[1] > span[0] && accept(match[group])) spans.push([span[0], span[1]]);
  }
}

/**
 * Credential shapes only (docs/326-ops-session-transcript req 3): URLs, paths, e-mail
 * addresses and commit hashes stay readable. It matches by shape, so a secret in a format
 * that is not listed here passes.
 *
 * Every shape is looked for in the ORIGINAL text, and the spans are merged. A replacement
 * that an earlier step made would hide the shape of a larger credential around it.
 *
 * The input can be megabytes of text that another session wrote, and this runs on the
 * orchestrator's main thread. A pattern added here must not scan a run again from each of
 * its positions: `redaction.test.ts` times the hostile inputs.
 */
export function redactCredentials(input: string): Stage1Result {
  const spans: Span[] = [];
  matchSpans(input, PRIVATE_KEY_BLOCK_RE, spans);
  matchSpans(input, URL_PASSWORD_RE, spans, 1);
  for (const { re } of KEY_PATTERNS) matchSpans(input, re, spans);
  matchSpans(input, AUTH_HEADER_RE, spans, 1);
  matchSpans(input, AUTH_SCHEME_RE, spans, 1, (value) => /\d/.test(value) || value.length >= 32);
  matchSpans(input, JWT_LINEAR_RE, spans, 1);
  assignmentValueSpans(input, spans);
  if (spans.length === 0) return { text: input, redactedCount: 0 };

  spans.sort((a, b) => a[0] - b[0]);
  let text = "";
  let copied = 0;
  let count = 0;
  let open: Span | undefined;
  for (const span of spans) {
    if (open && span[0] <= open[1]) {
      open[1] = Math.max(open[1], span[1]);
      continue;
    }
    if (open) {
      text += `${input.slice(copied, open[0])}${REDACTION_PLACEHOLDER}`;
      copied = open[1];
      count++;
    }
    open = [span[0], span[1]];
  }
  if (open) {
    text += `${input.slice(copied, open[0])}${REDACTION_PLACEHOLDER}`;
    copied = open[1];
    count++;
  }
  return { text: text + input.slice(copied), redactedCount: count };
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
