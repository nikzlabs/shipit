import { describe, expect, it } from "vitest";
import {
  createCliLineRelay,
  credentialParseFailure,
  sanitizeAuthDiagnostic,
  withoutSubmittedCodes,
} from "./auth-diagnostics.js";

describe("sanitizeAuthDiagnostic", () => {
  it("redacts auth URL details, token-like values, emails, API keys, and credential paths", () => {
    const sanitized = sanitizeAuthDiagnostic(
      "Open https://claude.ai/oauth/authorize?code=true&state=secret-state&code_challenge=secret-challenge " +
      "for person@example.com with Authorization: Bearer abcdefghijklmnop and sk-ant-secret " +
      "from /root/.claude/.credentials.json plus /credentials/.claude/auth.json",
    );

    expect(sanitized).toContain("https://claude.ai/oauth/authorize?[redacted]");
    expect(sanitized).toContain("[email redacted]");
    expect(sanitized).toContain("Bearer [redacted]");
    expect(sanitized).toContain("sk-ant-[redacted]");
    expect(sanitized).toContain("/root/.[redacted]");
    expect(sanitized).toContain("/credentials/[redacted]");
    expect(sanitized).not.toContain("secret-state");
    expect(sanitized).not.toContain("person@example.com");
    expect(sanitized).not.toContain("abcdefghijklmnop");
  });

  /**
   * The path rule used to name `.claude` and `.codex` only, which was already
   * one harness short: Antigravity's token sits under `.gemini`.
   */
  it("redacts a credential path under any harness's home directory", () => {
    const sanitized = sanitizeAuthDiagnostic(
      "wrote /root/.gemini/antigravity-cli/antigravity-oauth-token",
    );

    expect(sanitized).toBe("wrote /root/.[redacted]");
  });

  /**
   * A credential a CLI prints usually arrives as the JSON it came in, and that
   * shape passed every rule untouched: the assignment rule's value cannot start
   * with a quote, and a value this short is far below the long-secret threshold.
   */
  it("redacts a token assignment written as quoted JSON", () => {
    expect(sanitizeAuthDiagnostic('saved {"access_token":"short.secret/value"}')).toBe(
      'saved {"access_token":"[redacted]"}',
    );
  });

  // The key's quote used to end the match before the separator was reached.
  it("redacts a quoted key whose value is not quoted", () => {
    expect(sanitizeAuthDiagnostic('body {"refresh_token": v1.short/secret, "expiry": 1}')).toBe(
      'body {"refresh_token": [redacted], "expiry": 1}',
    );
  });

  /**
   * A quoted value ends at its own quote and nothing else. Excluding both quote
   * characters let the first of these through whole and cut the second in half,
   * publishing the tail as ordinary text.
   */
  it.each([
    { name: "the other quote character inside the value", line: `{"client_secret":"short'private/secret"}` },
    { name: "an escaped quote inside the value", line: `{"client_secret":"short\\"private/secret"}` },
    { name: "an unquoted key with a quoted value", line: `access_token="short.secret/value"` },
  ])("redacts a quoted value with $name", ({ line }) => {
    const sanitized = sanitizeAuthDiagnostic(line);

    expect(sanitized).toContain("[redacted]");
    expect(sanitized).not.toContain("private/secret");
    expect(sanitized).not.toContain("secret/value");
  });

  /**
   * Unbounded, the local part rescans every suffix of a long run that never
   * reaches an `@`. The input is the largest one the relay can hand over — a
   * line that reaches the buffered-line cap — and it cost 5.2 s in a single
   * call, on the thread that serves the UI.
   */
  it("does not scan quadratically over a long near-address", () => {
    const started = Date.now();
    sanitizeAuthDiagnostic("a.".repeat(32 * 1024));

    expect(Date.now() - started).toBeLessThan(1000);
  });

  /**
   * The URL rule runs after this one, and it rewrites the escaping this one
   * reads: it matched up to the backslash and removed it, which turned the
   * escaped quote into a real one and ended the value early.
   */
  it("redacts a quoted value holding a URL and an escaped quote", () => {
    const sanitized = sanitizeAuthDiagnostic(
      String.raw`{"access_token":"https://host.test/?x=abc\"tail/secret"}`,
    );

    expect(sanitized).not.toContain("tail/secret");
  });

  /**
   * `/[ \t]+\n/g` rescans every suffix of a long run of spaces that never
   * reaches a newline: 64 KiB of them cost 3.7 s in one call.
   */
  it("does not scan quadratically over a long run of spaces", () => {
    const started = Date.now();
    sanitizeAuthDiagnostic(`x${" ".repeat(64 * 1024)}X`);

    expect(Date.now() - started).toBeLessThan(1000);
  });

  // The separator is re-emitted, so the line still reads like what the CLI said.
  it("keeps the separator a token assignment was written with", () => {
    expect(sanitizeAuthDiagnostic("api_key: v1.short/secret")).toBe("api_key: [redacted]");
    expect(sanitizeAuthDiagnostic("api_key=v1.short/secret")).toBe("api_key=[redacted]");
  });
});

describe("withoutSubmittedCodes", () => {
  // Replacing the shorter one first leaves the longer code's tail behind with
  // nothing left to match it — and a corrected paste submits both.
  it("takes out the longest code first", () => {
    expect(
      withoutSubmittedCodes("rejected 4/short.private/long", ["4/short", "4/short.private/long"]),
    ).toBe("rejected [code-redacted]");
  });

  // A wrap can fall inside the code, and the refusal text is read unwrapped.
  it("takes out a code the CLI broke across a line", () => {
    expect(withoutSubmittedCodes("code 4/0AY\n-code here", ["4/0AY-code"])).toBe(
      "code [code-redacted] here",
    );
  });

  /**
   * A flush publishes whatever the CLI printed so far, which can be the first
   * half of an echoed code — and no whole-code match recognises a prefix.
   */
  it("takes out a trailing prefix of a code", () => {
    expect(withoutSubmittedCodes("echo 4/short.private/", ["4/short.private/code"])).toBe(
      "echo [code-redacted]",
    );
    expect(withoutSubmittedCodes("ends in 4/short", ["4/short.private/code"])).toBe(
      "ends in 4/short",
    );
  });

  /**
   * Built from the code as submitted, a code holding whitespace gave `\s*` runs
   * that could match the same spaces in many ways: 16 spaces in a 34-character
   * code took 10 s on one line, synchronously.
   */
  it("does not backtrack over a code that holds whitespace", () => {
    const started = Date.now();
    withoutSubmittedCodes(`a${" ".repeat(32)}c`, [`a${" ".repeat(16)}b`]);

    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("createCliLineRelay", () => {
  function collect() {
    const lines: { source: string; line: string }[] = [];
    const relay = createCliLineRelay((source, line) => lines.push({ source, line }));
    return { relay, lines };
  }

  it("holds a partial line back until its newline arrives", () => {
    const { relay, lines } = collect();
    relay.push("cli_stdout", "NSJF");
    expect(lines).toEqual([]);

    relay.push("cli_stdout", "-75ZB\nnext");
    expect(lines).toEqual([{ source: "cli_stdout", line: "NSJF-75ZB" }]);
  });

  /**
   * stdout and stderr break at independent points, so one shared tail would
   * splice a half-line from one stream onto a half-line from the other.
   */
  it("keeps each source's unterminated tail apart", () => {
    const { relay, lines } = collect();
    relay.push("cli_stdout", "out-");
    relay.push("cli_stderr", "err-");
    relay.push("cli_stdout", "one\n");
    relay.push("cli_stderr", "two\n");

    expect(lines).toEqual([
      { source: "cli_stdout", line: "out-one" },
      { source: "cli_stderr", line: "err-two" },
    ]);
  });

  it("drains every source's tail on flush, and drains it only once", () => {
    const { relay, lines } = collect();
    relay.push("cli_stdout", "no newline here");
    relay.push("cli_stderr", "nor here");
    relay.flush();
    relay.flush();

    expect(lines).toEqual([
      { source: "cli_stdout", line: "no newline here" },
      { source: "cli_stderr", line: "nor here" },
    ]);
  });

  it("strips ANSI so a colour code cannot split a secret in two", () => {
    const { relay, lines } = collect();
    relay.push("cli_stderr", "\x1b[90mNSJF-75ZB\x1b[0m\r\n");

    expect(lines).toEqual([{ source: "cli_stderr", line: "NSJF-75ZB" }]);
  });

  /**
   * The escape sequence itself can straddle a chunk boundary, and each half is
   * unrecognisable alone — so stripping per chunk leaves `\x1b[90m` glued to the
   * text. `m` is a word character, which destroys the `\b` every redaction
   * pattern needs; the sanitizer then removes the escape and publishes the
   * secret. Stripping the ASSEMBLED line is what closes it.
   */
  it("strips an escape sequence that was itself split across two chunks", () => {
    const { relay, lines } = collect();
    relay.push("cli_stderr", "  \x1b[9");
    relay.push("cli_stderr", "0mNSJF-75ZB\x1b[0m\n");

    expect(lines).toEqual([{ source: "cli_stderr", line: "  NSJF-75ZB" }]);
  });

  /**
   * Buffering until a newline means a CLI that never sends one would grow the
   * buffer for as long as the flow lives. The cap used to relay the fragment
   * instead — which is the split-secret leak in another guise, since the half
   * published at the break cannot be taken back and the next line carries the
   * rest. It withholds now, through to the end of that line, and says how much.
   */
  it("withholds a line that never ends, rather than publishing half of it", () => {
    const { relay, lines } = collect();
    relay.push("cli_stdout", `${" ".repeat(70 * 1024)}https://host.test/?sta`);
    expect(lines).toEqual([]);

    relay.push("cli_stdout", "te=private-state-value\n");
    expect(lines).toHaveLength(1);
    expect(lines[0].line).toContain("characters of unbroken CLI output withheld");
    expect(lines[0].line).not.toContain("private-state-value");

    relay.push("cli_stdout", "after\n");
    expect(lines[1], "the relay did not start again from empty").toEqual({
      source: "cli_stdout",
      line: "after",
    });
  });

  it("leaves a line under the cap buffered until its newline", () => {
    const { relay, lines } = collect();
    relay.push("cli_stdout", "y".repeat(60 * 1024));
    expect(lines).toEqual([]);
  });
});

describe("credentialParseFailure", () => {
  /**
   * The bytes a half-written token file trips over are the token: every harness
   * logged the parse error whole, and the generic rules cannot be relied on for
   * the ten-character fragment the message quotes.
   */
  it("keeps the file's bytes out of the message, and says what failed", () => {
    let logged = "";
    try {
      JSON.parse('{"access_token":ya29.secret-token-value}');
    } catch (err) {
      logged = credentialParseFailure(err);
    }

    expect(logged, "quoted the credential back into the log").not.toContain("ya29");
    expect(logged).toContain("[content redacted]");
    expect(logged).toContain("is not valid JSON");
  });

  // A message with no quoted context keeps every word it had.
  it("leaves a message that quotes nothing alone", () => {
    expect(credentialParseFailure(new Error("Unexpected end of JSON input"))).toBe(
      "Unexpected end of JSON input",
    );
  });
});

/**
 * A CLI on a pty reads the width it was spawned at and breaks its own output
 * there, newline included — so a whole physical line is still half a secret.
 * The width in these tests is the width a manager's spawn passes.
 */
describe("createCliLineRelay, on a CLI that wraps its own output", () => {
  const WIDTH = 80;

  function collect(wrapWidth?: number) {
    const lines: { source: string; line: string }[] = [];
    const relay = createCliLineRelay(
      (source, line) => lines.push({ source, line }),
      wrapWidth === undefined ? {} : { wrapWidth },
    );
    return { relay, lines };
  }

  // A real capture: the login link, broken at exactly the terminal width.
  const LINK = "https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-59"
    + "44d1962f5e&response_type=code&state=private-state-value";

  it("joins a wrapped line so the redaction sees the whole secret", () => {
    const { relay, lines } = collect(WIDTH);
    relay.push("cli_stdout", `${LINK.slice(0, WIDTH)}\n${LINK.slice(WIDTH)}\n`);

    expect(lines.map((l) => sanitizeAuthDiagnostic(l.line))).toEqual([
      "https://claude.ai/oauth/authorize?[redacted]",
    ]);
  });

  it("relays a line that did not fill the width on its own", () => {
    const { relay, lines } = collect(WIDTH);
    relay.push("cli_stdout", "Browser didn't open? Use the url below to sign in:\nnext line\n");

    expect(lines.map((l) => l.line)).toEqual([
      "Browser didn't open? Use the url below to sign in:",
      "next line",
    ]);
  });

  /**
   * The CLI can stop mid-wrap — a refusal printed over a link, a killed run.
   * The held half is still the user's only record of what happened, so flush
   * relays it rather than dropping it.
   */
  it("relays a still-held line on flush, once", () => {
    const { relay, lines } = collect(WIDTH);
    relay.push("cli_stdout", `${LINK.slice(0, WIDTH)}\n`);
    expect(lines).toEqual([]);

    relay.flush();
    relay.flush();
    expect(lines).toEqual([{ source: "cli_stdout", line: LINK.slice(0, WIDTH) }]);
  });

  /** The unterminated tail is exactly the continuation of what is held. */
  it("completes a held line with the tail flush drains", () => {
    const { relay, lines } = collect(WIDTH);
    relay.push("cli_stdout", `${LINK.slice(0, WIDTH)}\n${LINK.slice(WIDTH)}`);
    relay.flush();

    expect(lines).toEqual([{ source: "cli_stdout", line: LINK }]);
  });

  // Each stream wraps at its own points: one hold would splice them together.
  it("keeps each source's held line apart", () => {
    const { relay, lines } = collect(WIDTH);
    relay.push("cli_stdout", `${LINK.slice(0, WIDTH)}\n`);
    relay.push("cli_stderr", "a short stderr line\n");

    expect(lines).toEqual([{ source: "cli_stderr", line: "a short stderr line" }]);
  });

  /**
   * Codex and Grok read pipes, where nothing wraps: without a width there is
   * nothing to join, and a long line must not be held waiting for a
   * continuation that never comes.
   */
  it("joins nothing when no width was given", () => {
    const { relay, lines } = collect();
    relay.push("cli_stdout", `${LINK.slice(0, WIDTH)}\n${LINK.slice(WIDTH)}\n`);

    expect(lines.map((l) => l.line)).toEqual([LINK.slice(0, WIDTH), LINK.slice(WIDTH)]);
  });

  /**
   * A TUI drawing full-width frames joins rows that continue nothing, so the
   * accumulator has to end somewhere — and the end of an accumulator is a split
   * that can fall inside a secret. Publishing what it had and carrying the tail
   * forward was tried and rejected: the half published at the break is itself
   * half a secret, and nothing retracts it. So the block is withheld, through
   * to the line that ends it.
   */
  it("withholds the block the join cap ends, rather than publishing half of it", () => {
    const { relay, lines } = collect(WIDTH);
    // Just under the cap, so it is the link's first half that crosses it.
    const frames = `${"frame ".repeat(WIDTH).slice(0, WIDTH)}\n`.repeat(Math.floor((8 * 1024) / WIDTH));

    relay.push("cli_stdout", `${frames}${LINK.slice(0, WIDTH)}\nte=private-state-value\n`);

    const shown = lines.map((l) => sanitizeAuthDiagnostic(l.line)).join("\n");
    expect(shown, "published the continuation").not.toContain("private-state-value");
    expect(shown, "published the half it broke on").not.toContain("authorize?code=true");
    expect(shown).toContain("characters of unbroken CLI output withheld");
  });

  // A run can end mid-block, and silence would read as "the CLI printed nothing".
  it("reports a withheld block on flush, and reports it once", () => {
    const { relay, lines } = collect(WIDTH);
    relay.push("cli_stdout", `${"frame ".repeat(WIDTH).slice(0, WIDTH)}\n`.repeat(Math.ceil((8 * 1024) / WIDTH)));

    relay.flush();
    relay.flush();

    expect(lines).toHaveLength(1);
    expect(lines[0].line).toContain("characters of unbroken CLI output withheld");
  });

  /**
   * Width is a count of what the terminal counted, so the escapes come off
   * first: measuring the raw bytes makes a short coloured line look full-width
   * and joins it to a successor it never continued.
   */
  it("measures the line without its colour codes", () => {
    const { relay, lines } = collect(WIDTH);
    relay.push("cli_stdout", `\x1b[90m${"short line".padEnd(40)}\x1b[0m${"\x1b[2m".repeat(12)}\n`);
    relay.push("cli_stdout", "a second line\n");

    expect(lines.map((l) => l.line.trim())).toEqual(["short line", "a second line"]);
  });

  // Having decided the line was cut mid-token, the remainder's indent is decoration.
  it("drops the indent a CLI puts in front of a continuation", () => {
    const { relay, lines } = collect(WIDTH);
    relay.push("cli_stdout", `${LINK.slice(0, WIDTH)}\n   ${LINK.slice(WIDTH)}\n`);

    expect(lines.map((l) => l.line)).toEqual([LINK]);
  });
});
