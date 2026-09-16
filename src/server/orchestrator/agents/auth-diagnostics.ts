import { stripAnsi } from "../../shared/strip-ansi.js";
import type { LoginIntegrationId } from "../../shared/catalogue/types.js";
import type { AgentAuthPhase } from "../../shared/types/ws-server-messages.js";

/**
 * The record of one sign-in, as the panel in Settings shows it.
 *
 * **Harness-neutral, and it lives beside `agent-auth-base.ts` for that reason.**
 * It was `agents/claude/auth-diagnostics.ts`, with `loginId` pinned to the
 * `"anthropic-oauth"` literal and a `claude_*` source union — so every other
 * harness's sign-in could report nothing, and a failing Antigravity login left
 * the user with one summary sentence and no way to see what the CLI said. The
 * SSE layer was already generic (`app-lifecycle.ts` forwards `progress` and
 * `log` from every manager in `authManagers`); only these types were not.
 */

export type AgentAuthLogLevel = "debug" | "info" | "warn" | "error";

/** `cli_*` is whichever harness CLI the flow spawned; `shipit` is our own line. */
export type AgentAuthLogSource = "shipit" | "cli_stdout" | "cli_stderr" | "cli_control";

export interface AgentAuthProgressPayload {
  loginId: LoginIntegrationId;
  accountId?: string;
  attemptId: string;
  phase: AgentAuthPhase;
  message: string;
  elapsedMs?: number;
}

export interface AgentAuthLogPayload {
  loginId: LoginIntegrationId;
  accountId?: string;
  attemptId: string;
  timestamp: string;
  level: AgentAuthLogLevel;
  source: AgentAuthLogSource;
  message: string;
}

/**
 * Turns a CLI's stream chunks into whole LINES, one tail per source.
 *
 * **Every redaction protecting this panel is a whole-string rule**, so relaying
 * a chunk at a time defeats all of them: a sign-in URL split at `&sta` / `te=…`
 * leaves the second half looking like ordinary text, and a device code split
 * anywhere stops matching the pattern that removes it. stdout and stderr break
 * at independent points, so each carries its own tail, and {@link
 * CliLineRelay.flush} drains them where a CLI's last line — a prompt, or the
 * sentence explaining a failure — has no newline at all.
 */
export interface CliLineRelay {
  push(source: AgentAuthLogSource, chunk: string): void;
  /** Drain every source's unterminated tail, at every path that ends the run. */
  flush(): void;
}

export interface CliLineRelayOptions {
  /**
   * The terminal width the CLI was spawned at, for a CLI spawned on a pty.
   *
   * A CLI reads this width and breaks its own output at it, newline included,
   * so a link arrives as `…authorize?sta` + `te=private-state-value…` and no
   * whole-string rule recognises half a secret. Keep this and the spawn's
   * `cols` in one constant per manager; omit it for a CLI on a pipe, which has
   * no terminal to wrap at.
   *
   * **A full-width line is only PROBABLY continued by the next one**, and what
   * the guess misses and costs is in docs/301-antigravity-harness/plan.md.
   */
  wrapWidth?: number;
}

/** A line with no break in this many characters is withheld, not relayed. */
const MAX_BUFFERED_LINE = 64 * 1024;

/**
 * The same, for lines joined as one wrapped block. Far lower, because a join
 * aggregates unrelated rows where the line cap only ever held one line, and the
 * sanitizer is quadratic in places: 64 KiB in one call cost 5.6 s of the thread
 * that serves the UI. 8 KiB is still an order of magnitude above the longest
 * wrapped block a sign-in prints.
 */
const MAX_JOINED_LINE = 8 * 1024;

interface SourceState {
  /** Characters since the last newline. */
  tail: string;
  /** Full-width lines held for their continuation. */
  join: string;
  /** Characters dropped since a cap was hit; 0 when not withholding. */
  withheld: number;
  withholding: boolean;
}

/**
 * **A cap withholds; it never publishes a fragment.**
 *
 * The first shape of this published what it had accumulated and carried the
 * tail forward, which review reproduced as a leak from the other side: the
 * fragment published at the break can itself be the first half of a secret, and
 * nothing retracts it afterwards. Any bound has that property, so the bound
 * drops instead — and it keeps dropping until a line arrives that does not fill
 * the width, because the lines between are the rest of the same block.
 */
function withheldNotice(characters: number): string {
  return `[${characters} characters of unbroken CLI output withheld: no line break to redact them against]`;
}

export function createCliLineRelay(
  onLine: (source: AgentAuthLogSource, line: string) => void,
  opts: CliLineRelayOptions = {},
): CliLineRelay {
  // Per source: stdout and stderr break at independent points, so one shared
  // buffer would splice a half-line from one stream onto a half-line from the
  // other, and a block withheld on one would swallow the other's output.
  const sources = new Map<AgentAuthLogSource, SourceState>();
  const stateOf = (source: AgentAuthLogSource): SourceState => {
    const existing = sources.get(source);
    if (existing) return existing;
    const created: SourceState = { tail: "", join: "", withheld: 0, withholding: false };
    sources.set(source, created);
    return created;
  };

  /** True where a line did NOT fill the terminal, so nothing continues it. */
  const endsBlock = (clean: string): boolean =>
    opts.wrapWidth === undefined || clean.length < opts.wrapWidth;

  const withhold = (state: SourceState, characters: number): void => {
    // The join goes into the count, not onto the panel: whatever was already
    // accumulated belongs to the block being dropped.
    state.withheld += characters + state.join.length;
    state.join = "";
    state.withholding = true;
  };

  /**
   * **ANSI comes off the assembled line, never the chunk.** An escape sequence
   * split across chunks (`\x1b[9` + `0mCODE…`) is unrecognisable to each half,
   * so a per-chunk strip leaves `\x1b[90m` glued to the text — and `m` is a word
   * character, so the `\b` a redaction pattern needs is gone. Stripping is also
   * what makes the width comparison count what the terminal counted.
   */
  const accept = (source: AgentAuthLogSource, line: string): void => {
    const state = stateOf(source);
    const clean = stripAnsi(line);
    if (state.withholding) {
      state.withheld += clean.length;
      // An EMPTY line does not end the block. The rest of an over-long line
      // arrives as one when the newline follows immediately, and taking that as
      // the end published the line after it — which is the continuation the
      // withholding exists to keep back.
      if (!clean || !endsBlock(clean)) return;
      const characters = state.withheld;
      state.withheld = 0;
      state.withholding = false;
      onLine(source, withheldNotice(characters));
      return;
    }
    // Having decided the previous line was cut mid-token, the indent a CLI puts
    // in front of the remainder is decoration: left in, it ends the URL match at
    // the space and publishes everything after it.
    const joined = state.join ? state.join + clean.replace(/^[ \t]+/, "") : clean;
    if (!endsBlock(clean)) {
      if (joined.length >= MAX_JOINED_LINE) {
        state.join = "";
        withhold(state, joined.length);
        return;
      }
      state.join = joined;
      return;
    }
    // Cleared before the call, so a re-entrant push cannot replay the join.
    state.join = "";
    onLine(source, joined);
  };

  return {
    push(source, chunk) {
      const state = stateOf(source);
      const lines = (state.tail + chunk).split(/\r?\n/);
      state.tail = lines.pop() ?? "";
      for (const line of lines) accept(source, line);
      if (state.tail.length > MAX_BUFFERED_LINE) {
        withhold(state, state.tail.length);
        state.tail = "";
      }
    },
    flush() {
      for (const [source, state] of sources) {
        const tail = state.tail;
        state.tail = "";
        if (tail) accept(source, tail);
        if (state.withholding) {
          const characters = state.withheld + state.join.length;
          state.withheld = 0;
          state.join = "";
          state.withholding = false;
          onLine(source, withheldNotice(characters));
          continue;
        }
        // What is still joined has no continuation coming, so it is relayed
        // rather than withheld from the panel of a run that has ended — which
        // is why cancelling a run has to flush too, and not only exiting.
        const joined = state.join;
        state.join = "";
        if (joined) onLine(source, joined);
      }
    },
  };
}

const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;
/**
 * **The lengths are what keep this linear.** Unbounded, the local part rescans
 * every suffix of a long run that never reaches an `@` — 65 KiB of `a.a.a…`
 * cost 5.2 s in one call, on the thread that serves the UI. The bounds are RFC
 * 5321's (64 for the local part, 255 for the domain), so no address that could
 * be delivered is missed, and a local part longer than that is a long secret,
 * which {@link LONG_SECRET_PATTERN} removes.
 */
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,255}\.[A-Z]{2,}\b/gi;
const SECRET_KEYS =
  "access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|code_verifier|code_challenge|state|session|ticket|jwt|bearer";
/**
 * The key may be quoted and the separator may be a colon, because a CLI that
 * prints a credential usually prints the JSON it came in. The value's OPENING
 * quote counts as part of the separator, so a value whose closing quote has not
 * been printed yet — what a flush publishes mid-write — is still an assignment;
 * {@link QUOTED_TOKEN_ASSIGNMENT_PATTERN} needs both quotes and runs first. The quote after the
 * key is optional and the value's is not part of the value, so this covers
 * `access_token=…`, `access_token: …` and `"access_token": …`; a value in
 * quotes is {@link QUOTED_TOKEN_ASSIGNMENT_PATTERN}, whose match ends at the
 * closing quote instead of at whitespace.
 *
 * The separator is re-emitted rather than normalized to `=`: a line the user is
 * reading to work out what the CLI said should still look like what it said.
 */
const TOKEN_ASSIGNMENT_PATTERN = new RegExp(
  `\\b(${SECRET_KEYS})\\b(["']?\\s*[:=]\\s*["']?)([^\\s"',;]+)`,
  "gi",
);
/**
 * `{"access_token":"short.secret/value"}` passed through every rule unchanged:
 * the assignment rule's value cannot start with a quote, and a value under 32
 * characters is below the long-secret threshold.
 *
 * **A quoted value ends at ITS OWN quote, and nothing else.** Excluding both
 * quote characters let `"short'private/secret"` through whole and cut
 * `"short\"private/secret"` in half, publishing the tail; the escape form is
 * why `\\.` is an alternative rather than a character class. The key's quote is
 * optional because `access_token="…"` is the same assignment.
 */
const QUOTED_TOKEN_ASSIGNMENT_PATTERN = new RegExp(
  `(["']?)\\b(${SECRET_KEYS})\\b\\1(\\s*[:=]\\s*)(["'])(?:\\\\.|(?!\\4)[^\\\\])*\\4`,
  "gi",
);
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const ANTHROPIC_KEY_PATTERN = /\bsk-ant-[A-Za-z0-9._-]+/g;
const LONG_SECRET_PATTERN = /\b[A-Za-z0-9_-]{32,}\b/g;
/**
 * Every harness keeps its credentials in a dot-directory of the account HOME,
 * and the set is open (`.claude`, `.codex`, `.gemini`, and whatever the next
 * harness brings), so this matches the shape rather than a list that silently
 * stops covering a newly added backend.
 */
const ROOT_SECRET_PATH_PATTERN = /\/root\/\.[A-Za-z][\w.-]*(?:\/[^\s"'<>)]*)?/g;
const CREDENTIALS_PATH_PATTERN = /\/credentials\/[^\s"'<>)]*/g;

function sanitizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = url.search ? "?[redacted]" : "";
    url.hash = url.hash ? "#[redacted]" : "";
    return url.toString();
  } catch {
    return "[url redacted]";
  }
}

/**
 * **A sign-in URL does not survive this, and must not be logged through it.** An
 * OAuth link is all query string, and that is exactly what is stripped — so a
 * manager reports that the link arrived, and the link itself reaches the user as
 * the challenge's button, which is not sanitized.
 */
export function sanitizeAuthDiagnostic(input: string): string {
  return (
    stripAnsi(input)
      // Before the URL rule, which rewrites the escaping this one reads: in
      // `{"access_token":"https://h/?x=a\"tail/secret"}` the URL match ends at
      // the backslash, and removing it turns the escaped quote into a real one,
      // after which this rule ends the value early and publishes the tail.
      .replace(
        QUOTED_TOKEN_ASSIGNMENT_PATTERN,
        (_match, keyQuote: string, key: string, separator: string, valueQuote: string) =>
          `${keyQuote}${key}${keyQuote}${separator}${valueQuote}[redacted]${valueQuote}`,
      )
      .replace(URL_PATTERN, (url) => sanitizeUrl(url))
      .replace(EMAIL_PATTERN, "[email redacted]")
      .replace(ANTHROPIC_KEY_PATTERN, "sk-ant-[redacted]")
      .replace(BEARER_PATTERN, "Bearer [redacted]")
      .replace(
        TOKEN_ASSIGNMENT_PATTERN,
        (_match, key: string, separator: string) => `${key}${separator}[redacted]`,
      )
      .replace(ROOT_SECRET_PATH_PATTERN, "/root/.[redacted]")
      .replace(CREDENTIALS_PATH_PATTERN, "/credentials/[redacted]")
      .replace(LONG_SECRET_PATTERN, (value) => {
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
          return value;
        }
        return "[redacted]";
      })
      // Line by line, and `trimEnd` rather than a pattern: `/[ \t]+\n/g` rescans
      // every suffix of a long run of spaces that never reaches a newline, which
      // cost 3.7 s on 64 KiB of them.
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .trim()
  );
}

/**
 * The shortest prefix of an authorization code that is taken out of a flushed
 * tail. Long enough that ordinary text does not end in one by accident, short
 * enough to catch the first line of an echo the CLI had only half printed.
 */
const MIN_PARTIAL_CODE = 8;

/** No whitespace: a URL match ends at the first space, so a spaced marker
 * substituted inside a link truncates the redaction that follows it. */
const CODE_MARKER = "[code-redacted]";

/**
 * Take the authorization codes ShipIt submitted out of text the CLI produced.
 *
 * A pty echoes what is written to it and a CLI can quote a rejected code back,
 * so the panel and the failure message both see it; the long-secret rule would
 * probably catch it, and "probably" is not good enough for a credential.
 *
 * Three properties, each a reproduced leak rather than a precaution: **longest
 * code first**, because replacing `4/short` before `4/short.private/long`
 * leaves the longer one's tail with nothing to match it; **whitespace tolerated
 * between characters**, because a wrap can fall inside the code and the refusal
 * text is read unwrapped; and **a trailing prefix goes too**, because a flush
 * publishes what the CLI had printed so far, which can be half an echoed code.
 *
 * The marker carries no whitespace: a URL match ends at the first space, so a
 * spaced marker inside a link truncates the redaction that follows it.
 */
export function withoutSubmittedCodes(text: string, codes: readonly string[]): string {
  let out = text;
  for (const code of [...codes].sort((a, b) => b.length - a.length)) {
    if (!code) continue;
    out = code.length > MAX_CODE_PATTERN
      ? out.split(code).join(CODE_MARKER)
      : out.replace(wrappedCodePattern(code), CODE_MARKER);
    out = withoutTrailingPrefix(out, code);
  }
  return out;
}

/**
 * **A submitted code is caller input, and a pattern built from it is unbounded
 * unless something bounds it.** An 8 KiB "code" built a regex that Node refuses
 * with a stack-overflow `SyntaxError` — thrown out of the redaction, carrying
 * the generated pattern, and therefore the code, into the HTTP error. Past this
 * length the exact string is taken out instead: nothing that long is a code, so
 * the wrap tolerance is worth less than not throwing.
 */
const MAX_CODE_PATTERN = 512;

/**
 * **The `\s*` joins go between NON-whitespace characters only.** Built from the
 * code as submitted, a code holding 16 spaces took 10 s on one line: each `\s*`
 * could match the same spaces many ways. Dropping the code's own whitespace
 * matches the same text and pins every `\s*` with the literal after it.
 */
function wrappedCodePattern(code: string): RegExp {
  const chars = compactCharacters(code);
  return new RegExp(chars.map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*"), "g");
}

function compactCharacters(text: string): string[] {
  return (text.match(/[\s\S]/gu) ?? []).filter((ch) => !/\s/.test(ch));
}

/**
 * The comparison runs over the text with its whitespace taken out, because the
 * half-printed echo can carry the CLI's wrap inside it too — `4/short.\nprivate/`
 * is the same prefix as `4/short.private/`. The cut is made back in the original
 * text, at the character the count reached.
 */
function withoutTrailingPrefix(text: string, code: string): string {
  const compactCode = compactCharacters(code).join("");
  if (compactCode.length <= MIN_PARTIAL_CODE) return text;
  let compactTail = "";
  // The LONGEST match, not the first: a code whose first characters repeat
  // matches a short tail too, and cutting there leaves the rest of the prefix.
  let longestCut = -1;
  for (let i = text.length - 1; i >= 0 && compactTail.length < compactCode.length - 1; i -= 1) {
    const ch = text[i];
    if (/\s/.test(ch)) continue;
    compactTail = ch + compactTail;
    if (compactTail.length < MIN_PARTIAL_CODE) continue;
    if (compactCode.startsWith(compactTail)) longestCut = i;
  }
  return longestCut === -1 ? text : `${text.slice(0, longestCut)}${CODE_MARKER}`;
}

/**
 * What to log when a credential file will not parse.
 *
 * **A parse error quotes the bytes it tripped over, and in a credential file
 * those bytes are the credential** — Node answers a half-written token file
 * with `Unexpected token 'y', ..."ss_token":ya29.secre"... is not valid JSON`
 * (measured on 24.15.0). Every harness logs this failure the same way, so every
 * harness had the same line.
 */
export function credentialParseFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return sanitizeAuthDiagnostic(message.replace(/"[\s\S]*"/, "[content redacted]"));
}
