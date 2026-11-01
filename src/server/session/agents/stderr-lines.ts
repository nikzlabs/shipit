import { StringDecoder } from "node:string_decoder";
import { STDERR_TEXT_REMOVED } from "../../shared/redacted-tail.js";

export const STDERR_LINE_MAX_CHARS = 64_000;
export const STDERR_QUIET_MS = 250;

export interface StderrLines {
  write(chunk: Buffer): void;
  end(): void;
}

/**
 * Whole lines from the pipe chunks of a process's stderr. The readers of these logs redact
 * credentials by shape, and a chunk can end in the middle of one.
 *
 * A text with no line end is given when the stream goes quiet (a prompt waits with no line
 * end) and at the end. A line longer than the limit is removed, not cut: `onLine` gets
 * `STDERR_TEXT_REMOVED` in its place, and `onRemoved` gets the text.
 */
export function createStderrLines(
  onLine: (line: string) => void,
  onRemoved: (text: string) => void = () => {},
): StderrLines {
  const decoder = new StringDecoder("utf8");
  let rest = "";
  let removing = false;
  let writes = 0;
  let ended = false;
  let quiet: ReturnType<typeof setTimeout> | null = null;

  const give = (text: string): void => {
    for (const line of text.split("\n")) {
      if (line.length > STDERR_LINE_MAX_CHARS) {
        onLine(STDERR_TEXT_REMOVED);
        onRemoved(line);
        continue;
      }
      const trimmed = line.trim();
      if (trimmed) onLine(trimmed);
    }
  };

  const take = (text: string): void => {
    let fresh = text;
    if (removing) {
      const lineEnd = fresh.indexOf("\n");
      onRemoved(lineEnd === -1 ? fresh : fresh.slice(0, lineEnd));
      if (lineEnd === -1) return;
      removing = false;
      fresh = fresh.slice(lineEnd + 1);
    }
    const lastLineEnd = fresh.lastIndexOf("\n");
    if (lastLineEnd === -1) {
      rest += fresh;
    } else {
      const complete = rest + fresh.slice(0, lastLineEnd);
      const after = fresh.slice(lastLineEnd + 1);
      // `onLine` can call `end()`: the text after these lines must not come before them.
      rest = "";
      give(complete);
      if (ended) give(after);
      else rest = after;
    }
    if (rest.length > STDERR_LINE_MAX_CHARS) {
      const removed = rest;
      rest = "";
      removing = true;
      onLine(STDERR_TEXT_REMOVED);
      onRemoved(removed);
    }
  };

  const giveRest = (): void => {
    const text = rest;
    rest = "";
    give(text);
  };

  const armQuietTimer = (): void => {
    if (quiet) clearTimeout(quiet);
    quiet = null;
    if (!rest) return;
    const at = writes;
    quiet = setTimeout(() => {
      quiet = null;
      // A chunk that waits in the pipe is read before this runs.
      setImmediate(() => {
        if (!ended && writes === at) giveRest();
      });
    }, STDERR_QUIET_MS);
    quiet.unref();
  };

  return {
    write(chunk: Buffer): void {
      if (ended) return;
      writes += 1;
      take(decoder.write(chunk));
      armQuietTimer();
    },

    end(): void {
      if (ended) return;
      ended = true;
      if (quiet) clearTimeout(quiet);
      quiet = null;
      take(decoder.end());
      giveRest();
    },
  };
}
