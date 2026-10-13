import { execFile } from "node:child_process";
import type { AgentId } from "../../shared/types.js";
import {
  KEY_PATTERNS,
  REDACTION_PLACEHOLDER,
  type RedactionResult,
} from "../../shared/credential-redaction.js";

// The session worker redacts with these too, and its image has no orchestrator code.
export { REDACTION_PLACEHOLDER, redactCredentials } from "../../shared/credential-redaction.js";

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

// Git prints a remote with no user: `To github.com:acme/app.git`. The phrases are git's.
// With no phrase before it, `host:path` is also an image, a file with a key path and a
// bucket; a first path part that is a number is read as a port (planning#684). In a JSON log
// line, the phrase follows a written `\n`, which has no word boundary after it.
const GIT_OUTPUT_REMOTE_RE = new RegExp(
  String.raw`(?<=^|\W|\\[nrt])((?:To|From|Pushing to|refs to) '?)[A-Za-z0-9.-]{2,}:(?![0-9]+\/)(?:${SCP_PATH}|${SCP_PATH_PART}+\.git\b)`,
  "g",
);

// Lines of git and of git servers that name a repository and have no remote in them
// (planning#685). The phrase after the name is a condition too: with no `...` after it,
// `Cloning into 'x'` is also a sentence. A name ends at a quote or at white space, and each
// phrase has one of them in it, so no name is read again from a later phrase.
const QUOTED_NAME = String.raw`[^'\n\r]+`;
const GIT_MESSAGE_NAME_RES = [
  [String.raw`Cloning into (?:bare repository )?'`, QUOTED_NAME, String.raw`'\.\.\.`],
  [String.raw`destination path '`, QUOTED_NAME, String.raw`' already exists`],
  // With no `/` and no `.git`, the quoted text is in most cases the name of a remote:
  // `'origin'`.
  [
    String.raw`fatal: '`,
    String.raw`[^'\n\r/]*(?:\/[^'\n\r]*|\.git)`,
    String.raw`' does not appear to be a git repository`,
  ],
  [String.raw`repository '`, QUOTED_NAME, String.raw`' does not exist`],
  // GitHub and GitLab. The second name is found after the placeholder of the first one. No
  // phrase follows GitHub's second name: it ends where the characters of a name end.
  [String.raw`Permission to `, String.raw`[^\s/]+\/\S+`, String.raw` denied to `],
  [String.raw`Permission to \[REDACTED\] denied to `, String.raw`[A-Za-z0-9._/-]+`, ""],
  [String.raw`Project '`, QUOTED_NAME, String.raw`' was moved to '`],
  [String.raw`Project '\[REDACTED\]' was moved to '`, QUOTED_NAME, "'"],
].map(([before, name, after]) => new RegExp(`(${before})${name}(?=${after})`, "g"));

export type Stage1Result = RedactionResult;

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

  // The steps from here are last and only replace text: they cannot make redacted text visible.
  if (text.includes("@")) {
    text = text.replace(SCP_REMOTE_RE, (match: string, shape: unknown) => {
      if (shape === undefined) return match;
      count++;
      return REDACTION_PLACEHOLDER;
    });
  }
  // Not counted: it makes a redaction longer.
  text = text.replace(SCP_PATH_AFTER_REDACTION_RE, REDACTION_PLACEHOLDER);
  for (const re of [GIT_OUTPUT_REMOTE_RE, ...GIT_MESSAGE_NAME_RES]) {
    text = text.replace(re, (_match: string, phrase: string) => {
      count++;
      return `${phrase}${REDACTION_PLACEHOLDER}`;
    });
  }

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
