import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { memo } from "react";
import { render, cleanup } from "@testing-library/react";
import type { ChatMessage } from "./types.js";
import type { TranscriptRowProps } from "./TranscriptRow.js";

/**
 * planning#375 — the guard for the whole fix.
 *
 * `TranscriptRow` is memoized, but a memo only bails out if the props it is
 * given are referentially stable, and THAT is a property of `MessageList`, not
 * of the row. It is also silently losable: a `useMemo` dropped from
 * `matchesByMessage`, a `previous` argument dropped from `buildVisualElements`,
 * a fresh arrow function passed as a prop — any one of those restores the
 * measured 92 ms whole-transcript re-render with nothing failing.
 *
 * So this test replaces the row with a memoized counter and asserts what the
 * user actually cares about: appending a message, or growing the streaming one,
 * must not re-render the rows above it.
 */
const renders = new Map<string, number>();

vi.mock("./TranscriptRow.js", () => ({
  TranscriptRow: memo((props: TranscriptRowProps) => {
    const key = props.el.kind === "message" ? `m-${props.el.index}` : props.el.kind;
    renders.set(key, (renders.get(key) ?? 0) + 1);
    return <div data-testid={key} />;
  }),
}));

const { MessageList } = await import("./MessageList.js");

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  renders.clear();
});

function user(text: string): ChatMessage { return { role: "user", text }; }
function bot(text: string, streaming = false): ChatMessage {
  return { role: "assistant", text, streaming };
}

describe("MessageList — memoized rows bail out", () => {
  it("does not re-render existing rows when a message is appended", () => {
    const base = [user("one"), bot("two"), user("three")];
    const { rerender } = render(<MessageList messages={base} isLoading={false} />);
    expect(renders.get("m-0")).toBe(1);
    expect(renders.get("m-1")).toBe(1);
    expect(renders.get("m-2")).toBe(1);

    // A new message arrives. The array is new (as it always is), but every
    // ChatMessage object in the prefix is the same one.
    rerender(<MessageList messages={[...base, bot("four")]} isLoading={false} />);

    expect(renders.get("m-0")).toBe(1);
    expect(renders.get("m-1")).toBe(1);
    expect(renders.get("m-2")).toBe(1);
    expect(renders.get("m-3")).toBe(1);
  });

  it("re-renders only the streaming row as its text grows", () => {
    const head = [user("q"), bot("answer so far", true)];
    const { rerender } = render(<MessageList messages={head} isLoading />);
    expect(renders.get("m-0")).toBe(1);
    expect(renders.get("m-1")).toBe(1);

    // Three tokens land. Each replaces only the last message object.
    for (const text of ["answer so far a", "answer so far ab", "answer so far abc"]) {
      rerender(<MessageList messages={[head[0], { ...head[1], text }]} isLoading />);
    }

    // The row above the streaming one never re-rendered — this is the whole
    // point: the cost of a token is now O(changed rows), not O(transcript).
    expect(renders.get("m-0")).toBe(1);
    expect(renders.get("m-1")).toBe(4);
  });

  it("still re-renders a row when its own message object changes", () => {
    const base = [user("one"), bot("two")];
    const { rerender } = render(<MessageList messages={base} isLoading={false} />);
    expect(renders.get("m-0")).toBe(1);

    // Editing the FIRST message must redraw the first row and leave the second.
    rerender(<MessageList messages={[{ ...base[0], text: "one edited" }, base[1]]} isLoading={false} />);
    expect(renders.get("m-0")).toBe(2);
    expect(renders.get("m-1")).toBe(1);
  });

  it("does not re-render rows when the parent hands down fresh callbacks", () => {
    const base = [user("one"), bot("two")];
    const { rerender } = render(
      <MessageList messages={base} isLoading={false} onSendFollowUp={() => true} />,
    );
    expect(renders.get("m-0")).toBe(1);

    // A parent re-render re-creates every callback prop. Those travel by ref
    // (row-context.tsx), so they must not invalidate a single row.
    rerender(<MessageList messages={base} isLoading={false} onSendFollowUp={() => true} />);
    expect(renders.get("m-0")).toBe(1);
    expect(renders.get("m-1")).toBe(1);
  });
});
