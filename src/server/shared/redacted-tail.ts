import { redactCredentials } from "./credential-redaction.js";

const BUDGET_CHARS = 64_000;

// A cut of the budget can go through a credential. The part that stays is at the start of the
// kept text, and no pattern knows it. It is assumed shorter than this.
const CUT_GUARD_CHARS = 8_000;

function commonEnd(a: string, b: string): string {
  let length = 0;
  while (length < a.length && length < b.length && a.at(-1 - length) === b.at(-1 - length)) length += 1;
  return a.slice(a.length - length);
}

/**
 * The redaction reads the pieces with a line end between them. That is the text that an
 * adapter read from the process when it emits lines. The Codex adapter emits trimmed pipe
 * chunks, so a credential that a chunk boundary cut stays in two parts.
 */
export function createRedactedTail(): { add(text: string): void; read(maxChars: number): string } {
  let raw = "";
  let cut = false;

  return {
    add(text: string): void {
      if (!text) return;
      raw = raw ? `${raw}\n${text}` : text;
      if (raw.length <= BUDGET_CHARS) return;
      raw = raw.slice(-BUDGET_CHARS);
      cut = true;
    },

    read(maxChars: number): string {
      // All of the kept text is redacted before the length is cut and the white space goes.
      const whole = redactCredentials(raw).text;
      // After a cut, the text is made from the raw text behind the guard only, so it has nothing
      // of the part at the start. It is shown only where the redaction of all the text agrees.
      const shown = cut ? commonEnd(redactCredentials(raw.slice(CUT_GUARD_CHARS)).text, whole) : whole;
      const line = shown.replace(/\s+/g, " ").trim();
      return line.length > maxChars ? `…${line.slice(-maxChars)}` : line;
    },
  };
}
