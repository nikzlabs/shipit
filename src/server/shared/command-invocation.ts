/**
 * docs/299 — an agent CLI reads its own command only when the message is exactly
 * the command: measured, text before it means no command is seen at all, and
 * text after it lands inside the command's argument.
 *
 * The name pattern excludes the realistic false positives — a path-first message
 * (`/tmp/foo.ts is broken`) keeps a slash inside the token, a shell-variable
 * mention (`$HOME is unset`) is uppercase, and an amount (`$100 is the budget`)
 * has no letter. Every command a pinned CLI lists, and every skill name, is
 * lowercase. A false positive that remains only defers this turn's notices to the
 * next message; it destroys nothing.
 */
const COMMAND_NAME = /^[a-z0-9][a-z0-9._:-]*$/;

/** @param prefix the harness's `skillInvocationPrefix` — `/` for most, `$` for Codex. */
export function isCommandInvocation(text: string, prefix: string | undefined): boolean {
  if (!prefix) return false;
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(prefix)) return false;
  const [name = ""] = trimmed.slice(prefix.length).split(/\s/, 1);
  return COMMAND_NAME.test(name) && /[a-z]/.test(name);
}
