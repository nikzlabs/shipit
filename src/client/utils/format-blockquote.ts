/**
 * SHI-10 — turn a selected passage from a chat message into a markdown
 * blockquote suitable for dropping into the composer.
 *
 * Each line is prefixed with `> ` (blank lines become a bare `>` so the quote
 * stays a single contiguous blockquote in markdown rather than splitting into
 * two). Surrounding whitespace is trimmed first so a selection that happens to
 * include a trailing newline doesn't produce a dangling empty quote line.
 *
 * Returns an empty string for whitespace-only input so callers can cheaply
 * decide whether there's anything worth inserting.
 */
export function formatBlockquote(text: string): string {
  const trimmed = text.replace(/\r\n/g, "\n").trim();
  if (trimmed === "") return "";
  return trimmed
    .split("\n")
    .map((line) => (line.trim() === "" ? ">" : `> ${line}`))
    .join("\n");
}
