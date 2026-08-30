import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import type { SearchMatch } from "../../hooks/useSearch.js";
import type { ChatMessage } from "./types.js";

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
 * **Two probes, because there are two different questions.**
 *
 * `attempts` counts calls reaching `highlightCached` — every one is a call the
 * chain of `memo` + `useMemo` failed to stop. That is the right probe for the
 * memo chain and the obvious one is wrong: the cache absorbs repeats, so a
 * broken chain measured at the highlighter would show up as *zero* extra work
 * and every assertion here would pass while the property it names was broken
 * (found in review).
 *
 * `runs` counts calls reaching `highlightCode`, the real work behind the cache.
 * That is the right probe for the one thing the memo chain cannot cover — a
 * fiber that does not survive — and it is deliberately NOT a spy on
 * `highlight.js`: `syntax-highlight.ts` imports `highlight.js/lib/core`, a
 * different module instance from the full build, so such a spy intercepts
 * nothing and reads 0 forever.
 *
 * Both layers are left real underneath, so the tests run the production path.
 *
 * If one of these goes red, the failure is almost certainly a REMOUNT: the memos
 * compare strings by value, so a code block with unchanged text cannot re-enter
 * the factory while it stays mounted. Look for a changed `key`, a component type
 * built during render, or a conditional that swaps the subtree.
 */

const attempts: { code: string; language: string }[] = [];
const runs: string[] = [];

vi.mock("../../utils/highlight-cache.js", async (importOriginal) => {
  // eslint-disable-next-line no-restricted-syntax -- `importOriginal`'s type parameter is the module's own shape; there is no top-level form for it inside a factory that must not hoist a real import.
  const real = await importOriginal<typeof import("../../utils/highlight-cache.js")>();
  return {
    ...real,
    highlightCached: (code: string, language: string) => {
      attempts.push({ code, language });
      return real.highlightCached(code, language);
    },
  };
});

vi.mock("../../syntax-highlight.js", async (importOriginal) => {
  // eslint-disable-next-line no-restricted-syntax -- as above; the factory must not hoist a real import.
  const real = await importOriginal<typeof import("../../syntax-highlight.js")>();
  return {
    ...real,
    highlightCode: (code: string, language?: string | null) => {
      runs.push(code);
      return real.highlightCode(code, language);
    },
  };
});

const { clearHighlightCache, HIGHLIGHT_CACHE_LIMITS } = await import("../../utils/highlight-cache.js");
const { MessageList } = await import("./MessageList.js");

const CODE = Array.from({ length: 40 }, (_, i) => `  const value_${i} = compute(${i});`).join("\n");
/** No language on the fence, so this takes the auto-detection path. */
const UNLABELLED_BLOCK = `Here it is:\n\n\`\`\`\n${CODE}\n\`\`\`\n\nThat's the file.`;

function bot(text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { role: "assistant", text, ...extra };
}
function user(text: string): ChatMessage {
  return { role: "user", text };
}

/** Calls that got past `memo` + `useMemo`, i.e. the work the chain failed to skip. */
function highlightAttempts(): number {
  return attempts.length;
}

/** Calls that got past the cache too, i.e. the highlighting actually performed. */
function highlightRuns(): number {
  return runs.length;
}

function startCounting() {
  // The cache lives for the module, so one test's blocks would otherwise still
  // be resident for another's — which changes nothing about `attempts` (that
  // probe is above the cache) but is what makes `runs` mean anything.
  clearHighlightCache();
  attempts.length = 0;
  runs.length = 0;
}

const realScrollIntoView = Element.prototype.scrollIntoView;

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});

afterAll(() => {
  Element.prototype.scrollIntoView = realScrollIntoView;
});

afterEach(() => {
  cleanup();
});

describe("MessageList — a transcript update does not re-highlight unchanged code", () => {
  it("highlights a fenced block once, however often the parent re-renders", () => {
    startCounting();
    const block = bot(UNLABELLED_BLOCK);
    const base = [user("show me"), block];

    const { rerender } = render(<MessageList messages={base} isLoading={false} />);
    expect(highlightAttempts()).toBe(1);

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

    expect(highlightAttempts()).toBe(1);
  });

  it("does not re-highlight when the message objects are rebuilt", () => {
    startCounting();
    const build = () => [user("show me"), bot(UNLABELLED_BLOCK)];

    const { rerender } = render(<MessageList messages={build()} isLoading={false} />);
    expect(highlightAttempts()).toBe(1);

    // A history reload / turn snapshot replaces every `ChatMessage` object, so
    // each row's `anchor` prop changes identity and every row re-renders. The
    // block's text is byte-identical, so the highlight must not be re-attempted.
    for (let i = 0; i < 5; i++) rerender(<MessageList messages={build()} isLoading={false} />);

    expect(highlightAttempts()).toBe(1);
  });

  it("does not re-highlight an earlier block while a later message streams", () => {
    startCounting();
    const block = bot(UNLABELLED_BLOCK);
    const { rerender } = render(
      <MessageList messages={[block, bot("thinking", { streaming: true })]} isLoading />,
    );
    expect(highlightAttempts()).toBe(1);

    for (const text of ["thinking a", "thinking ab", "thinking abc", "thinking abcd"]) {
      rerender(<MessageList messages={[block, bot(text, { streaming: true })]} isLoading />);
    }

    expect(highlightAttempts()).toBe(1);
  });

  it("does not re-highlight when a search runs over the transcript", () => {
    startCounting();
    const base = [user("show me"), bot(UNLABELLED_BLOCK)];
    const { rerender } = render(<MessageList messages={base} isLoading={false} />);
    expect(highlightAttempts()).toBe(1);

    // Typing in the search bar rebuilds `searchMatches` on every keystroke,
    // which rebuilds `matchesByMessage` — a prop on every row.
    for (let i = 1; i <= 4; i++) {
      const matches: SearchMatch[] = [{ messageIndex: 0, start: 0, length: i }];
      rerender(
        <MessageList messages={base} isLoading={false} searchMatches={matches} currentMatch={matches[0]} />,
      );
    }

    expect(highlightAttempts()).toBe(1);
  });

  it("holds when the transcript has more distinct blocks than the cache can keep", () => {
    // The cache is bounded, so beyond its capacity it stops hiding anything —
    // which is exactly when a broken memo chain becomes expensive again on a
    // long conversation. The contract has to hold at that scale on its own.
    startCounting();
    // Deliberately tiny blocks: this test is about how many highlights are
    // ATTEMPTED past the capacity line, and 72 full-size ones would spend the
    // whole budget of the suite on auto-detection proving nothing extra.
    const n = HIGHLIGHT_CACHE_LIMITS.MAX_ENTRIES + 8;
    const build = () =>
      Array.from({ length: n }, (_, i) => bot(`Block ${i}\n\n\`\`\`\nconst b${i} = ${i};\n\`\`\``));

    const messages = build();
    const { rerender } = render(<MessageList messages={messages} isLoading={false} />);
    expect(highlightAttempts()).toBe(n);

    // Every message object replaced, twice. Each row re-renders; none of the
    // blocks changed, so nothing may re-enter the factory — cache or no cache.
    rerender(<MessageList messages={build()} isLoading={false} />);
    rerender(<MessageList messages={build()} isLoading={false} />);

    expect(highlightAttempts()).toBe(n);
  });

  it("highlights each block once when a new message is appended", () => {
    startCounting();
    const first = bot(UNLABELLED_BLOCK);
    const { rerender } = render(<MessageList messages={[first]} isLoading={false} />);
    expect(highlightAttempts()).toBe(1);

    // A second, DIFFERENT block legitimately costs one more highlight — and the
    // first block must not be re-highlighted to pay for it.
    const second = bot(`And another:\n\n\`\`\`\n${CODE}\nconst extra = 1;\n\`\`\``);
    rerender(<MessageList messages={[first, second]} isLoading={false} />);

    expect(highlightAttempts()).toBe(2);
  });
});

/**
 * The one thing the memo chain cannot cover: a fiber that does not survive. This
 * is what `highlightCached` exists for, so here the probe is the real
 * highlighter — the memo boundary is expected to be crossed, and the question is
 * whether the expensive work runs again behind it.
 */
describe("MessageList — a remount does not re-run the highlighter", () => {
  it("reuses the highlight for a block that remounts with the same text", () => {
    startCounting();
    const base = [user("show me"), bot(UNLABELLED_BLOCK)];

    const first = render(<MessageList messages={base} isLoading={false} />);
    expect(highlightRuns()).toBe(1);
    first.unmount();

    // A remount is what a `useMemo` cannot cover, and the transcript reaches it
    // by several ordinary routes: history cleared and rehydrated, a tool-call
    // modal reopened, crossing the mobile/desktop breakpoint (which swaps two
    // distinct trees in `AppLayout`), a row whose `key` changed.
    render(<MessageList messages={base} isLoading={false} />);

    // The memo chain is expected to let this one through — a mounting component
    // always runs its factory — and the cache is what makes it free.
    expect(highlightAttempts()).toBe(2);
    expect(highlightRuns()).toBe(1);
  });
});
