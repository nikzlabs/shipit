import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import type { SearchMatch } from "../../hooks/useSearch.js";
import type { ChatMessage } from "./types.js";

/**
 * The probe is `highlightCode`, not `highlight.js`.
 *
 * `syntax-highlight.ts` imports `highlight.js/lib/core`, a different module
 * instance from the full `highlight.js` build — so a `vi.spyOn` on the latter
 * intercepts nothing and every count here would read as 0.
 */
const calls: string[] = [];

vi.mock("../../syntax-highlight.js", async (importOriginal) => {
  // eslint-disable-next-line no-restricted-syntax -- `importOriginal`'s type parameter is the module's own shape; there is no top-level form for it inside a factory that must not hoist a real import.
  const real = await importOriginal<typeof import("../../syntax-highlight.js")>();
  return {
    ...real,
    highlightCode: (code: string, language?: string | null) => {
      calls.push(code);
      return real.highlightCode(code, language);
    },
  };
});

const { clearHighlightCache } = await import("../../utils/highlight-cache.js");
const { MessageList } = await import("./MessageList.js");

/**
 * planning#375 (docs/265) — the memo chain, measured in the unit that hurts.
 *
 * `transcript-row-memo.test.tsx` guards the same contract one level up, but it
 * MOCKS `TranscriptRow`, so it is blind by construction to everything the row
 * renders: `MarkdownContent`'s memo, `CodeBlock`'s memo, and the `useMemo` that
 * highlights. A change that leaves the row bailing out correctly while
 * remounting something inside it passes that test and still costs a syntax
 * highlight per update.
 *
 * Highlighting is the right thing to count because it is the dominant cost and
 * because it is *countable*: auto-detection runs every registered grammar over
 * the block, and a production trace measured 274 ms for a ~400-line block.
 * So the contract is stated as work, not as render counts — **a transcript
 * update must not re-highlight a code block whose text did not change.**
 *
 * If one of these goes red, the failure is almost certainly a REMOUNT: the
 * memos compare strings by value, so a code block with unchanged text cannot
 * re-highlight while it stays mounted. Look for a changed `key`, a component
 * type built during render, or a conditional branch that swaps the subtree.
 */

const CODE = Array.from({ length: 40 }, (_, i) => `  const value_${i} = compute(${i});`).join("\n");
/** No language on the fence, so this takes the auto-detection path. */
const UNLABELLED_BLOCK = `Here it is:\n\n\`\`\`\n${CODE}\n\`\`\`\n\nThat's the file.`;

function bot(text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { role: "assistant", text, ...extra };
}
function user(text: string): ChatMessage {
  return { role: "user", text };
}

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
});

/** Highlight runs that got past `memo` + `useMemo` + the cache. */
function runs(): number {
  return calls.length;
}

function startCounting() {
  // The cache lives for the module, so one test's blocks would otherwise answer
  // another's and every count here would read as 0.
  clearHighlightCache();
  calls.length = 0;
}

describe("MessageList — a transcript update does not re-highlight unchanged code", () => {
  it("highlights a fenced block once, however often the parent re-renders", () => {
    startCounting();
    const block = bot(UNLABELLED_BLOCK);
    const base = [user("show me"), block];

    const { rerender } = render(<MessageList messages={base} isLoading={false} />);
    expect(runs()).toBe(1);

    // What `App` does on every store update: a fresh array, freshly-created
    // inline callbacks, and a changed `sessionTitle` (which feeds every row's
    // `forkDefaultName`). None of it touches the block's text.
    for (let i = 0; i < 10; i++) {
      rerender(
        <MessageList
          messages={[...base]}
          isLoading={false}
          sessionTitle={`title ${i}`}
          onSendFollowUp={() => true}
          onRewindAtGap={() => {}}
          onRequestRewindPreview={() => {}}
        />,
      );
    }

    expect(runs()).toBe(1);
  });

  it("does not re-highlight when the message objects are rebuilt", () => {
    startCounting();
    const build = () => [user("show me"), bot(UNLABELLED_BLOCK)];

    const { rerender } = render(<MessageList messages={build()} isLoading={false} />);
    expect(runs()).toBe(1);

    // A history reload / turn snapshot replaces every `ChatMessage` object, so
    // each row's `anchor` prop changes identity and every row re-renders. The
    // block's text is byte-identical, so the highlight must not be re-paid.
    for (let i = 0; i < 5; i++) rerender(<MessageList messages={build()} isLoading={false} />);

    expect(runs()).toBe(1);
  });

  it("does not re-highlight an earlier block while a later message streams", () => {
    startCounting();
    const block = bot(UNLABELLED_BLOCK);
    const { rerender } = render(
      <MessageList messages={[block, bot("thinking", { streaming: true })]} isLoading />,
    );
    expect(runs()).toBe(1);

    for (const text of ["thinking a", "thinking ab", "thinking abc", "thinking abcd"]) {
      rerender(<MessageList messages={[block, bot(text, { streaming: true })]} isLoading />);
    }

    expect(runs()).toBe(1);
  });

  it("does not re-highlight when a search runs over the transcript", () => {
    startCounting();
    const base = [user("show me"), bot(UNLABELLED_BLOCK)];
    const { rerender } = render(<MessageList messages={base} isLoading={false} />);
    expect(runs()).toBe(1);

    // Typing in the search bar rebuilds `searchMatches` on every keystroke,
    // which rebuilds `matchesByMessage` — a prop on every row.
    for (let i = 1; i <= 4; i++) {
      const matches: SearchMatch[] = [{ messageIndex: 0, start: 0, length: i }];
      rerender(
        <MessageList messages={base} isLoading={false} searchMatches={matches} currentMatch={matches[0]} />,
      );
    }

    expect(runs()).toBe(1);
  });

  it("does not re-highlight a block that remounts with the same text", () => {
    startCounting();
    const base = [user("show me"), bot(UNLABELLED_BLOCK)];

    const first = render(<MessageList messages={base} isLoading={false} />);
    expect(runs()).toBe(1);
    first.unmount();

    // A remount is what a `useMemo` cannot cover, and the transcript reaches it
    // by several ordinary routes: a session switch and back, a tool-call modal
    // reopened, a row whose `key` changed. React also discards a `useMemo` from
    // a concurrent render it abandons, which `MessageList`'s `useDeferredValue`
    // makes routine while the user scrolls — the production trace showed 35
    // highlights of ONE payload inside 15 s that way.
    render(<MessageList messages={base} isLoading={false} />);

    expect(runs()).toBe(1);
  });

  it("highlights each block once when a new message is appended", () => {
    startCounting();
    const first = bot(UNLABELLED_BLOCK);
    const { rerender } = render(<MessageList messages={[first]} isLoading={false} />);
    expect(runs()).toBe(1);

    // A second, DIFFERENT block legitimately costs one more highlight — and the
    // first block must not be re-highlighted to pay for it.
    const second = bot(`And another:\n\n\`\`\`\n${CODE}\nconst extra = 1;\n\`\`\``);
    rerender(<MessageList messages={[first, second]} isLoading={false} />);

    expect(runs()).toBe(2);
  });
});
