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
   * **A whole line is not a whole string when the CLI itself wraps.** A CLI
   * reads the pty's width and breaks its own output at it, newline included, so
   * a sign-in link arrives as `…authorize?sta` + `te=private-state-value…`: the
   * first line loses its query string to the URL rule and the second is
   * published as ordinary text, because no whole-string rule recognises half a
   * secret. Widening the spawn only moves that boundary — anything longer than
   * the width still wraps — so the fix is to put the logical line back together
   * before redacting it.
   *
   * **The width comes from the spawn, but "this line continues that one" is
   * still a guess.** Keep the two numbers in one constant per manager, and omit
   * this for a CLI on a pipe (Codex, Grok), where the terminal that would wrap
   * does not exist. What the guess buys is the ordinary case: plain text hard
   * wrapped at the width. What it does **not** cover, measured rather than
   * assumed:
   *
   * - A line that reaches the width through cursor motion (`ESC[2C`) or a
   *   double-width character holds fewer characters than the width, so it is
   *   not recognised as wrapped and its continuation is published alone.
   * - A CLI that indents its continuation lines breaks a URL match at the
   *   indent even after the join.
   * - A line that merely happens to fill the width is joined to a successor
   *   that never continued it. The cost is not only a long panel line: the
   *   successor's text is read as part of the first line's URL, so a short
   *   diagnostic after a full-width one can be redacted away with it.
   *
   * Reading the display width exactly means emulating a terminal, which none of
   * this is worth. This narrows a reproducible leak; it is not a proof that the
   * panel cannot leak.
   */
  wrapWidth?: number;
}

/**
 * The point at which a CLI that never emits a newline stops being buffered and
 * starts being relayed anyway.
 *
 * **A cap is not a chunk boundary in disguise.** It sits three orders of
 * magnitude above the whole output of a device-auth login, so no URL, token or
 * code can straddle it — which is the one thing that would turn this back into
 * the per-chunk relay the whole design exists to avoid.
 */
const MAX_BUFFERED_LINE = 64 * 1024;

/**
 * The point at which joined lines stop accumulating.
 *
 * Far lower than {@link MAX_BUFFERED_LINE}, and for two measured reasons. A
 * join aggregates unrelated rows — a TUI drawing full-width frames joins them
 * all — where the buffered-line cap only ever held ONE line, so this bound is
 * what the sanitizer's cost is paid on: at 64 KiB one `sanitizeAuthDiagnostic`
 * call took 5.6 s of the orchestrator's single thread, and the panel is fed
 * from an event callback. 8 KiB is still an order of magnitude above the
 * longest wrapped block a sign-in produces (a ~400-character OAuth link at 80
 * columns is five lines).
 */
const MAX_JOINED_LINE = 8 * 1024;

interface HeldLine {
  text: string;
  /** False once the text has been published, so flush cannot repeat it. */
  unpublished: boolean;
}

export function createCliLineRelay(
  onLine: (source: AgentAuthLogSource, line: string) => void,
  opts: CliLineRelayOptions = {},
): CliLineRelay {
  const tails = new Map<AgentAuthLogSource, string>();
  // Per source, like the tails: a line held for its continuation must not be
  // completed by whatever the other stream printed next.
  const wrapped = new Map<AgentAuthLogSource, HeldLine>();
  /**
   * **ANSI comes off the assembled line, never the chunk.** An escape sequence
   * split across chunks (`\x1b[9` + `0mCODE…`) is unrecognisable to each half,
   * so a per-chunk strip leaves `\x1b[90m` glued to the text — and `m` is a word
   * character, so the `\b` a redaction pattern needs is gone. The sanitizer
   * strips the escape later and publishes the secret it was meant to remove.
   *
   * The join happens on the stripped text, and the escapes are why: a wrap
   * lands between printable characters, so measuring a coloured line against
   * the terminal width has to count what the terminal counted.
   */
  const emit = (source: AgentAuthLogSource, line: string): void => {
    const width = opts.wrapWidth;
    const clean = stripAnsi(line);
    const held = wrapped.get(source)?.text ?? "";
    // Having decided the previous line was cut mid-token, the indent a CLI puts
    // in front of the remainder is decoration, not content — and left in, it
    // ends the URL match at the space and publishes everything after it.
    const joined = held ? held + clean.replace(/^[ \t]+/, "") : clean;
    if (width !== undefined && clean.length >= width) {
      if (joined.length < MAX_JOINED_LINE) {
        wrapped.set(source, { text: joined, unpublished: true });
        return;
      }
      /**
       * **A forced break is where the split-secret leak comes back**, so what
       * is published stays in front of the next line rather than being dropped.
       * The join's own cap is reachable by ordinary output — unlike the
       * buffered-line cap — so a secret CAN straddle it, and the carried tail is
       * what lets the next line be redacted with the context it needs. The
       * repeat costs the panel one duplicated line's worth of text.
       */
      wrapped.set(source, { text: joined.slice(-width), unpublished: false });
      onLine(source, joined);
      return;
    }
    // Cleared before the emit, so a re-entrant push cannot replay the join.
    wrapped.set(source, { text: "", unpublished: false });
    onLine(source, joined);
  };
  return {
    push(source, chunk) {
      const lines = ((tails.get(source) ?? "") + chunk).split(/\r?\n/);
      let tail = lines.pop() ?? "";
      // The cap is a synthetic line break, not a drop: the fragment is relayed
      // through the same redactions as any other line rather than discarded.
      if (tail.length > MAX_BUFFERED_LINE) {
        lines.push(tail);
        tail = "";
      }
      tails.set(source, tail);
      for (const line of lines) emit(source, line);
    },
    flush() {
      for (const [source, tail] of tails) {
        // Cleared before the emit, so a re-entrant push cannot replay the tail.
        tails.set(source, "");
        if (tail) emit(source, tail);
      }
      // The tails go first: a held line's continuation is exactly what an
      // unterminated tail is when the CLI stops mid-wrap. Whatever is still
      // held after that has no continuation coming, so it is relayed as it is
      // rather than withheld from the panel of a run that has ended — which is
      // why every path that ends a run, cancellation included, has to flush.
      for (const [source, held] of wrapped) {
        wrapped.set(source, { text: "", unpublished: false });
        if (held.unpublished && held.text) onLine(source, held.text);
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
  "access[_-]?token|refresh[_-]?token|auth[_-]?token|api[_-]?key|client[_-]?secret|code_verifier|code_challenge|state|session|ticket|jwt|bearer";
/**
 * The key may be quoted and the separator may be a colon, because a CLI that
 * prints a credential usually prints the JSON it came in. The quote after the
 * key is optional and the value's is not part of the value, so this covers
 * `access_token=…`, `access_token: …` and `"access_token": …`; a value in
 * quotes is {@link QUOTED_TOKEN_ASSIGNMENT_PATTERN}, whose match ends at the
 * closing quote instead of at whitespace.
 *
 * The separator is re-emitted rather than normalized to `=`: a line the user is
 * reading to work out what the CLI said should still look like what it said.
 */
const TOKEN_ASSIGNMENT_PATTERN = new RegExp(
  `\\b(${SECRET_KEYS})\\b(["']?\\s*[:=]\\s*)([^\\s"',;]+)`,
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
  return stripAnsi(input)
    .replace(URL_PATTERN, (url) => sanitizeUrl(url))
    .replace(EMAIL_PATTERN, "[email redacted]")
    .replace(ANTHROPIC_KEY_PATTERN, "sk-ant-[redacted]")
    .replace(BEARER_PATTERN, "Bearer [redacted]")
    .replace(
      QUOTED_TOKEN_ASSIGNMENT_PATTERN,
      (_match, keyQuote: string, key: string, separator: string, valueQuote: string) =>
        `${keyQuote}${key}${keyQuote}${separator}${valueQuote}[redacted]${valueQuote}`,
    )
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
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/**
 * What to log when a credential file will not parse.
 *
 * **A parse error quotes the bytes it tripped over, and in a credential file
 * those bytes are the credential** — Node answers a half-written token file
 * with `Unexpected token 'y', ..."ss_token":ya29.secre"... is not valid JSON`
 * (measured on 24.15.0). Every harness logs this failure the same way, so every
 * harness had the same line. The reason a parse failed is worth a log line; the
 * bytes around the fault are not, so the quoted context goes before the generic
 * rules, which cannot be relied on to catch a ten-character fragment of a token.
 */
/**
 * Take the authorization codes ShipIt submitted out of text the CLI produced.
 *
 * A pty echoes what is written to it, and a CLI can quote a rejected code back
 * in its error, so the panel and the failure message both see it. The
 * sanitizer's long-secret rule would probably catch it; "probably" is not good
 * enough for a credential, so the exact strings we submitted come out by name.
 *
 * **The match tolerates whitespace between any two characters, because a wrap
 * can fall inside the code.** The relay unwraps what it can, but the refusal
 * text is read from the raw buffer — it has to stay Google's own sentence
 * (docs/301-antigravity-harness req 4) — and there an exact match failed on
 * `4/0AY\n-code` while the panel's copy of the same line was clean.
 *
 * **The marker carries no whitespace.** A URL match ends at the first space, so
 * a spaced marker substituted inside a link truncates what the sanitizer then
 * sees and publishes every parameter after it.
 */
export function withoutSubmittedCodes(text: string, codes: readonly string[]): string {
  let out = text;
  for (const code of codes) {
    if (!code) continue;
    out = out.replace(wrappedCodePattern(code), "[code-redacted]");
  }
  return out;
}

function wrappedCodePattern(code: string): RegExp {
  const chars = code.match(/[\s\S]/gu) ?? [];
  return new RegExp(chars.map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*"), "g");
}

export function credentialParseFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return sanitizeAuthDiagnostic(message.replace(/"[\s\S]*"/, "[content redacted]"));
}
