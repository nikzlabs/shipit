import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The probe is `highlightCode`, not `highlight.js`.
 *
 * `syntax-highlight.ts` imports `highlight.js/lib/core`, a different module
 * instance from the full `highlight.js` build — so a `vi.spyOn(hljs, …)` on the
 * latter intercepts nothing and every count here would read as 0. Spying on the
 * boundary the cache actually calls is both correct and the thing under test:
 * the cache's whole job is how often that call happens.
 */
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
    // An unregistered language renders plain (docs/265 — `highlightCode` refuses
    // to guess when the fence named something). That `null` is a real answer, so
    // it must not be re-derived on every remount of a Haskell block.
    expect(highlightCached("main = putStrLn \"hi\"", "haskell")).toBeNull();
    expect(highlightCached("main = putStrLn \"hi\"", "haskell")).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("keeps declared and undeclared language apart", () => {
    // The key is the text alone, so an entry stored under one language must not
    // answer for another — two fences with the same body and different languages
    // are different renders, even where auto-detection happens to agree.
    highlightCached(TS, "");
    expect(calls).toHaveLength(1);

    highlightCached(TS, "python");
    expect(calls).toHaveLength(2);
    expect(calls[1].language).toBe("python");

    // ...and the displaced entry is genuinely gone, not shadowed.
    highlightCached(TS, "");
    expect(calls).toHaveLength(3);
  });

  // The retention tests below drive `plaintext`, which is registered and whose
  // grammar does no real work — these need hundreds of calls and megabyte
  // inputs, and the cache's bookkeeping is identical whichever branch ran.
  const PLAIN = "plaintext";

  it("is bounded, and evicts the least recently used block", () => {
    // One block we keep touching, then enough distinct blocks to overflow the
    // cache. The touched one must survive; the first filler must not.
    highlightCached("KEEP", PLAIN);
    for (let i = 0; i < HIGHLIGHT_CACHE_LIMITS.MAX_ENTRIES * 2; i++) {
      highlightCached(`filler ${i}`, PLAIN);
      highlightCached("KEEP", PLAIN);
    }
    const before = calls.length;

    highlightCached("KEEP", PLAIN);
    expect(calls).toHaveLength(before); // still cached

    highlightCached("filler 0", PLAIN);
    expect(calls).toHaveLength(before + 1); // evicted, recomputed
  });

  it("counts a recomputed entry as the newest, not as its old position", () => {
    // Overwriting an existing Map key leaves it where it was in insertion order,
    // so a block re-highlighted under a different language would stay the OLDEST
    // and be the next one evicted — recomputed and then thrown away. Found in
    // review; this is the regression test for it.
    highlightCached("SUBJECT", PLAIN);
    for (let i = 0; i < HIGHLIGHT_CACHE_LIMITS.MAX_ENTRIES - 1; i++) {
      highlightCached(`filler ${i}`, PLAIN);
    }
    // SUBJECT is now the oldest entry. Re-request it under a different language,
    // which is a miss and replaces it, then push the cache one over capacity.
    highlightCached("SUBJECT", "python");
    highlightCached("one more", PLAIN);

    const before = calls.length;
    highlightCached("SUBJECT", "python");
    expect(calls).toHaveLength(before); // survived: recency was refreshed
  });

  it("bounds retained characters, not just the number of entries", () => {
    // A handful of blocks, each a sixth of the character budget — far inside the
    // entry cap, far past the byte one. An entry-only bound would keep them all.
    const big = (tag: string) => tag + "x".repeat(Math.floor(HIGHLIGHT_CACHE_LIMITS.MAX_CHARS / 6));
    for (let i = 0; i < 10; i++) highlightCached(big(`b${i}`), PLAIN);

    const before = calls.length;
    highlightCached(big("b0"), PLAIN);
    expect(calls).toHaveLength(before + 1); // evicted by the byte budget
  });

  it("keeps the most recent block even when it alone exceeds the budget", () => {
    // An oversized block is exactly the one worth not recomputing; evicting it on
    // insert would make the cache a no-op for the most expensive input there is.
    const huge = "y".repeat(HIGHLIGHT_CACHE_LIMITS.MAX_CHARS + 1);
    highlightCached(huge, PLAIN);
    const before = calls.length;

    highlightCached(huge, PLAIN);
    expect(calls).toHaveLength(before);
  });
});
