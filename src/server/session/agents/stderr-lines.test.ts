import { describe, it, expect, vi, afterEach } from "vitest";
import { createStderrLines, STDERR_LINE_MAX_CHARS, STDERR_QUIET_MS } from "./stderr-lines.js";
import { createRedactedTail, REDACTED_TAIL_NOT_SHOWN, STDERR_TEXT_REMOVED } from "../../shared/redacted-tail.js";

function collect(): {
  lines: string[];
  removed: string[];
  write: (text: string | Buffer) => void;
  end: () => void;
} {
  const lines: string[] = [];
  const removed: string[] = [];
  const stderr = createStderrLines((line) => lines.push(line), (text) => removed.push(text));
  return {
    lines,
    removed,
    write: (text) => { stderr.write(typeof text === "string" ? Buffer.from(text) : text); },
    end: () => { stderr.end(); },
  };
}

describe("createStderrLines", () => {
  afterEach(() => vi.useRealTimers());

  it("gives a line that two chunks hold one time, and whole", () => {
    const { lines, write } = collect();
    write("Error: failed to initialize sqlite sta");
    expect(lines).toEqual([]);
    write("te runtime\n");
    expect(lines).toEqual(["Error: failed to initialize sqlite state runtime"]);
  });

  it("gives each line of one chunk, trimmed, and no empty line", () => {
    const { lines, write } = collect();
    write("state db backfill is running\r\n\n   waiting up to 30s\nError: timed");
    expect(lines).toEqual(["state db backfill is running", "waiting up to 30s"]);
  });

  it("gives the same lines for each division of the same bytes", () => {
    const text = "first line\nsecond: é and 日本\n\nthird with no line end";
    const bytes = Buffer.from(text);
    const whole = collect();
    whole.write(bytes);
    whole.end();
    expect(whole.lines).toEqual(["first line", "second: é and 日本", "third with no line end"]);

    for (let cut = 1; cut < bytes.length; cut += 1) {
      const parts = collect();
      parts.write(bytes.subarray(0, cut));
      parts.write(bytes.subarray(cut));
      parts.end();
      expect(parts.lines, `cut at byte ${cut}`).toEqual(whole.lines);
    }
  });

  it("gives the text with no line end at the end", () => {
    const { lines, write, end } = collect();
    write("fatal: no line end");
    expect(lines).toEqual([]);
    end();
    expect(lines).toEqual(["fatal: no line end"]);
  });

  it("gives a text with no line end when the stream goes quiet", () => {
    vi.useFakeTimers();
    const { lines, write } = collect();
    write("Enter your API key: ");
    vi.advanceTimersByTime(STDERR_QUIET_MS - 1);
    vi.runAllTicks();
    expect(lines).toEqual([]);
    vi.advanceTimersByTime(1);
    vi.runAllTimers();
    expect(lines).toEqual(["Enter your API key:"]);
  });

  it("waits again when more of the line comes before the stream is quiet", () => {
    vi.useFakeTimers();
    const { lines, write } = collect();
    write("loading");
    vi.advanceTimersByTime(STDERR_QUIET_MS - 1);
    write(" the state");
    vi.advanceTimersByTime(STDERR_QUIET_MS - 1);
    expect(lines).toEqual([]);
    vi.advanceTimersByTime(1);
    vi.runAllTimers();
    expect(lines).toEqual(["loading the state"]);
  });

  // A stalled event loop makes the timer late, and the next chunk is then already in the pipe.
  it("does not divide a line when the next chunk is read after the quiet time ended", () => {
    vi.useFakeTimers();
    const { lines, write } = collect();
    write("fatal: par");
    vi.advanceTimersToNextTimer();
    write("tial");
    vi.advanceTimersToNextTimer();
    expect(lines).toEqual([]);
    write(" line\n");
    expect(lines).toEqual(["fatal: partial line"]);
  });

  it("gives nothing after the end", () => {
    vi.useFakeTimers();
    const { lines, write, end } = collect();
    write("last words");
    end();
    write("from a closed pipe\n");
    vi.runAllTimers();
    expect(lines).toEqual(["last words"]);
  });

  // The primary turn kills the adapter from its auth_required listener, and the kill ends this.
  it("keeps the order of the lines when a line callback ends the stream", () => {
    const lines: string[] = [];
    const stderr = createStderrLines((line) => {
      lines.push(line);
      if (line === "Unauthorized") stderr.end();
    });
    stderr.write(Buffer.from("Unauthorized\nmiddle\nlast"));
    expect(lines).toEqual(["Unauthorized", "middle", "last"]);
  });

  it("removes a line that is longer than the limit, to its line end, and keeps the next line", () => {
    const { lines, write } = collect();
    for (let i = 0; i < 70; i += 1) write("x".repeat(1_000));
    expect(lines).toEqual([STDERR_TEXT_REMOVED]);
    write("the end of the long line\nthe next line\n");
    expect(lines).toEqual([STDERR_TEXT_REMOVED, "the next line"]);
    write("one more line\n");
    expect(lines).toEqual([STDERR_TEXT_REMOVED, "the next line", "one more line"]);
  });

  it("removes a long line that came whole in one chunk", () => {
    const { lines, write } = collect();
    write(`${"x".repeat(STDERR_LINE_MAX_CHARS + 1)}\nshort\n`);
    expect(lines).toEqual([STDERR_TEXT_REMOVED, "short"]);
  });

  it("gives the removed text to the second callback, so that a reader can still search it", () => {
    const { removed, write } = collect();
    write("x".repeat(STDERR_LINE_MAX_CHARS + 1));
    write(" 401 Unauthorized");
    write(" at the end\nnext\n");
    expect(removed.join("")).toBe(`${"x".repeat(STDERR_LINE_MAX_CHARS + 1)} 401 Unauthorized at the end`);
  });

  it("counts the length of a line the same way for each division of its bytes", () => {
    const spaces = " ".repeat(STDERR_LINE_MAX_CHARS + 1);
    const whole = collect();
    whole.write(`${spaces}fatal\n`);
    const parts = collect();
    parts.write(spaces);
    parts.write("fatal\n");
    expect(whole.lines).toEqual([STDERR_TEXT_REMOVED]);
    expect(parts.lines).toEqual(whole.lines);
  });

  // The first line holds the name and the first quote of a value that goes on in the next line.
  it("lets the redacted tail show nothing after a line was removed", () => {
    const opaque = "q7".repeat(20);
    const longLine = `API_KEY="${"x".repeat(STDERR_LINE_MAX_CHARS)}`;
    const inOneChunk = collect();
    inOneChunk.write(`${longLine}\n${opaque}" fatal\n`);
    const inTwoChunks = collect();
    inTwoChunks.write(longLine);
    inTwoChunks.write(`\n${opaque}" fatal\n`);

    for (const { lines } of [inOneChunk, inTwoChunks]) {
      const tail = createRedactedTail();
      for (const line of lines) tail.add(line);
      expect(tail.read(300)).toBe(REDACTED_TAIL_NOT_SHOWN);
    }
  });
});
