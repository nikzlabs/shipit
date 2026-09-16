import { describe, expect, it } from "vitest";
import { createCliLineRelay, sanitizeAuthDiagnostic } from "./auth-diagnostics.js";

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
   * buffer for as long as the flow lives. The cap relays the fragment instead of
   * dropping it, and then starts again from empty.
   */
  it("relays and resets rather than buffering a line that never ends", () => {
    const { relay, lines } = collect();
    relay.push("cli_stdout", "x".repeat(70 * 1024));
    expect(lines).toHaveLength(1);
    expect(lines[0].line).toHaveLength(70 * 1024);

    relay.push("cli_stdout", "after\n");
    expect(lines[1], "the buffer kept the relayed fragment").toEqual({
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
