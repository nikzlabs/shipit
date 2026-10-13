export const REDACTION_PLACEHOLDER = "[REDACTED]";

export const KEY_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{12,}/g },
  { name: "openai-key", re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { name: "github-token", re: /\b(?:gh[posur]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { name: "aws-key", re: /\b(?:AKIA|ASIA)[A-Z0-9]{12,}/g },
  { name: "google-key", re: /\bAIza[A-Za-z0-9_-]{20,}/g },
  { name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{8,}/g },
];

export interface RedactionResult {
  text: string;
  redactedCount: number;
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
 * its positions: `orchestrator/services/redaction.test.ts` times the hostile inputs.
 */
export function redactCredentials(input: string): RedactionResult {
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
