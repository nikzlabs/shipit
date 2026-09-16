/**
 * The OSC body excludes ESC and accepts either terminator, and both halves of
 * that matter. A body that may contain ESC rescans to the end of the text from
 * every `\x1b]` in it, so a stream of them is quadratic — 32 KiB took 425 ms,
 * and the sign-in panel hands this whole CLI lines. Excluding ESC also lets an
 * OSC end at the string terminator `ESC \` the way a terminal reads it; matching
 * only BEL swallowed the terminator and everything after it, up to the next BEL.
 */
export function stripAnsi(text: string): string {
  /* eslint-disable no-control-regex -- stripping ANSI/terminal sequences requires matching control chars */
  return text.replace(
    /\x1b(?:\[[0-9;<>?]*[a-zA-Z@`~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()#][A-Z0-9]|[>=<])/g,
    "",
  );
  /* eslint-enable no-control-regex */
}
