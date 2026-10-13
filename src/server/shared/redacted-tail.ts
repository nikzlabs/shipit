import { redactCredentials } from "./credential-redaction.js";

const BUDGET_CHARS = 256_000;

/** An emitter of stderr lines gives this in place of text that it removed. */
export const STDERR_TEXT_REMOVED = "[ShipIt removed a stderr line that was too long]";

export const REDACTED_TAIL_NOT_SHOWN = "[not shown: too long for a safe redaction]";

/**
 * The redaction reads all of the text, with a line end between the pieces, before a length is
 * cut. A text with a part removed cannot be redacted: the cut can go through a credential, and
 * it changes which quotes are a pair in all the text after it. So nothing is shown of a text
 * that is longer than the budget, or that has `STDERR_TEXT_REMOVED` in it. Each adapter must
 * give whole lines for the same reason.
 */
export function createRedactedTail(): { add(text: string): void; read(maxChars: number): string } {
  let raw = "";
  let incomplete = false;

  return {
    add(text: string): void {
      if (!text || incomplete) return;
      const next = raw ? `${raw}\n${text}` : text;
      if (text === STDERR_TEXT_REMOVED || next.length > BUDGET_CHARS) {
        incomplete = true;
        raw = "";
        return;
      }
      raw = next;
    },

    read(maxChars: number): string {
      if (incomplete) return REDACTED_TAIL_NOT_SHOWN;
      const line = redactCredentials(raw).text.replace(/\s+/g, " ").trim();
      return line.length > maxChars ? `…${line.slice(-maxChars)}` : line;
    },
  };
}
