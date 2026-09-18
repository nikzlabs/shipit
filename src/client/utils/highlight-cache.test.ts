import { describe, it, expect, beforeEach, vi } from "vitest";

const calls: { code: string; language?: string | null }[] = [];

vi.mock("../syntax-highlight.js", async (importOriginal) => {
  // eslint-disable-next-line no-restricted-syntax -- `importOriginal`'s type parameter is the module's own shape; there is no top-level form for it inside a factory that must not hoist a real import.
  const real = await importOriginal<typeof import("../syntax-highlight.js")>();
  return {
    ...real,
    highlightCode: (code: string, language?: string | null) => {
      calls.push({ code, language });
      return real.highlightCode(code, language);
    },
  };
});

const { highlightCode } = await import("../syntax-highlight.js");
const { highlightCached, clearHighlightCache, HIGHLIGHT_CACHE_LIMITS } = await import("./highlight-cache.js");

const TS = "const x: number = 1;\nexport default x;";

beforeEach(() => {
  clearHighlightCache();
  calls.length = 0;
});

describe("highlightCached", () => {
  it("returns exactly what highlightCode returns, and decides nothing itself", () => {
    expect(highlightCached(TS, "typescript")).toBe(highlightCode(TS, "typescript"));
    clearHighlightCache();
    expect(highlightCached(TS, "")).toBe(highlightCode(TS, ""));
  });

  it("highlights the same text once", () => {
    const first = highlightCached(TS, "");
    const second = highlightCached(TS, "");
    expect(second).toBe(first);
    expect(calls).toHaveLength(1);
  });

  it("caches a null as readily as a rendering", () => {

    // it must not be re-derived on every remount of a Haskell block.
    expect(highlightCached("main = putStrLn \"hi\"", "haskell")).toBeNull();
    expect(highlightCached("main = putStrLn \"hi\"", "haskell")).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("keeps declared and undeclared language apart", () => {
    // The key is the text alone, so an entry stored under one language must not

    highlightCached(TS, "");
    expect(calls).toHaveLength(1);

    highlightCached(TS, "python");
    expect(calls).toHaveLength(2);
    expect(calls[1].language).toBe("python");

    highlightCached(TS, "");
    expect(calls).toHaveLength(3);
  });

  const PLAIN = "plaintext";

  it("is bounded, and evicts the least recently used block", () => {

    // cache. The touched one must survive; the first filler must not.
    highlightCached("KEEP", PLAIN);
    for (let i = 0; i < HIGHLIGHT_CACHE_LIMITS.MAX_ENTRIES * 2; i++) {
      highlightCached(`filler ${i}`, PLAIN);
      highlightCached("KEEP", PLAIN);
    }
    const before = calls.length;

    highlightCached("KEEP", PLAIN);
    expect(calls).toHaveLength(before);                

    highlightCached("filler 0", PLAIN);
    expect(calls).toHaveLength(before + 1);                       
  });

  it("counts a recomputed entry as the newest, not as its old position", () => {

    highlightCached("SUBJECT", PLAIN);
    for (let i = 0; i < HIGHLIGHT_CACHE_LIMITS.MAX_ENTRIES - 1; i++) {
      highlightCached(`filler ${i}`, PLAIN);
    }

    highlightCached("SUBJECT", "python");
    highlightCached("one more", PLAIN);

    const before = calls.length;
    highlightCached("SUBJECT", "python");
    expect(calls).toHaveLength(before);                                   
  });

  it("bounds retained characters, not just the number of entries", () => {

    const big = (tag: string) => tag + "x".repeat(Math.floor(HIGHLIGHT_CACHE_LIMITS.MAX_CHARS / 6));
    for (let i = 0; i < 10; i++) highlightCached(big(`b${i}`), PLAIN);

    const before = calls.length;
    highlightCached(big("b0"), PLAIN);
    expect(calls).toHaveLength(before + 1);                              
  });

  it("keeps the most recent block even when it alone exceeds the budget", () => {

    const huge = "y".repeat(HIGHLIGHT_CACHE_LIMITS.MAX_CHARS + 1);
    highlightCached(huge, PLAIN);
    const before = calls.length;

    highlightCached(huge, PLAIN);
    expect(calls).toHaveLength(before);
  });
});
