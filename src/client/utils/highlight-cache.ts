import { highlightCode } from "../syntax-highlight.js";

/**
 * Syntax highlighting, remembered across renders that do not survive.
 *
 * This layer decides **nothing** about how a block is highlighted. `syntax-
 * highlight.ts` owns that — which grammars are registered, that an unlabeled
 * fence is auto-detected across the registered subset, and that a fence naming
 * an unregistered language renders plain rather than guessed. Adding a language
 * there still reaches every call site with no edit here. All this adds is that
 * the answer outlives the fiber that asked for it.
 *
 * **Why that is needed.** Every call site already wraps the call in a `useMemo`
 * keyed on the block's text, which is why the repetition below reads as
 * impossible. It is not, because a `useMemo` is not a cache — React's own
 * documentation says a memoized value may be thrown away. Precisely, and this is
 * narrower than it is tempting to write:
 *
 *   - A **mounting** component always runs the factory. So every remount pays
 *     the full cost again — a code block behind a modal, a tooltip or a
 *     disclosure is re-highlighted every time that surface opens, and anything
 *     that remounts transcript rows does it for the whole conversation.
 *   - On an **update**, React compares the deps against the last *committed*
 *     value, not against the last attempt: `updateWorkInProgressHook` clones the
 *     hook from `currentlyRenderingFiber.alternate` and `updateMemo` compares
 *     against that clone (verified in react-dom 19.2.8). So a render React
 *     abandons and retries recomputes any memo whose deps differ from the commit
 *     — but an *unchanged* block is not recomputed merely because a render was
 *     interrupted.
 *
 * Keeping the answer outside render state removes the cost in both cases: it
 * becomes a property of the *content* rather than of the render lifecycle.
 *
 * The production trace that prompted this (2026-08-30) measured 35
 * `highlightAuto` calls on one payload for 9.5 s of a 10.4 s busy main thread,
 * at ~274 ms each. Bounding the grammar set has since cut a single auto-detect
 * of that block to roughly 20 ms, so what is saved per remount is much smaller
 * than it was — but it is still a synchronous render-blocking pass over the
 * whole block, repeated for text that has not changed.
 *
 * **This is a mitigation, not an identification.** Which surface produced those
 * 35 calls is still open — see `docs/265-transcript-render-cost`. A real-browser
 * harness ruled out scrolling, parent re-renders and message-object churn as
 * triggers, and no key collision or render-declared component type was found in
 * the transcript chain. What this changes is that the cost no longer depends on
 * which of them it turns out to be.
 *
 * Keyed by the code string itself (not by a `language + code` concatenation,
 * which would retain a second copy of every block). A block's language is fixed
 * by the fence that produced it, so an entry stored under a different language
 * is a genuine miss: it recomputes and replaces, and can never serve the wrong
 * rendering.
 *
 * One entry per code string, not a per-language map under it. Review raised the
 * alternative: two byte-identical bodies behind differently-labelled fences
 * would then both stay cached instead of displacing each other. It is left
 * undone on purpose — that collision needs the same body twice in one
 * transcript with different fences, and the cost when it happens is one
 * recompute per alternation, against a second level of map and of eviction
 * accounting on every block.
 */

interface Entry {
  language: string;
  /** `null` is a real answer — an unregistered language renders plain — so it caches. */
  html: string | null;
}

/**
 * Retention bounds. Both are enforced, because either alone is a bound on the
 * wrong thing: an entry count says nothing about size (nothing caps how long an
 * assistant's code block may be), and a byte budget alone would let thousands of
 * one-line blocks accumulate.
 *
 * Sized for "the blocks on screen and the ones just scrolled past", not for a
 * whole conversation: the keys are strings the transcript is holding anyway
 * while a block is live, so a cache that outlived the transcript by much would
 * be keeping dropped sessions' text alive for the lifetime of the page.
 *
 * The most recent entry is always kept, even when it alone exceeds the budget —
 * an oversized block is exactly the one worth not recomputing, and evicting it
 * on insert would make the cache a no-op for it.
 */
const MAX_ENTRIES = 64;
const MAX_CHARS = 1_000_000;

const cache = new Map<string, Entry>();
let cachedChars = 0;

/** Both halves of an entry are retained, so both count against the budget. */
function weigh(code: string, entry: Entry): number {
  // `?? 0` because `html` is legitimately null for an unregistered language.
  return code.length + (entry.html?.length ?? 0);
}

function evictToBudget(): void {
  while (cache.size > 1 && (cache.size > MAX_ENTRIES || cachedChars > MAX_CHARS)) {
    const oldest = cache.keys().next();
    if (oldest.done) return;
    drop(oldest.value);
  }
}

function drop(code: string): void {
  const entry = cache.get(code);
  if (!entry) return;
  cachedChars -= weigh(code, entry);
  cache.delete(code);
}

/**
 * {@link highlightCode}, reusing an earlier result for the same text and
 * language. Same arguments, same return — including `null` for a language
 * nothing answers to.
 */
export function highlightCached(code: string, language: string): string | null {
  const hit = cache.get(code);
  if (hit?.language === language) {
    // Refresh recency so a block that is still being read is not evicted by a
    // burst of blocks scrolling past it.
    cache.delete(code);
    cache.set(code, hit);
    return hit.html;
  }

  const html = highlightCode(code, language);

  // `drop` before `set`, not `set` alone: overwriting an existing key leaves it
  // at its original position in the Map's insertion order, so a freshly
  // recomputed entry would stay the oldest and be the next one evicted.
  drop(code);
  const entry: Entry = { language, html };
  cache.set(code, entry);
  cachedChars += weigh(code, entry);
  evictToBudget();
  return html;
}

/** Test-only: drop everything, so one test's blocks cannot satisfy another's. */
export function clearHighlightCache(): void {
  cache.clear();
  cachedChars = 0;
}

/** Test-only: the retention bounds, so a capacity guard cannot drift from them. */
export const HIGHLIGHT_CACHE_LIMITS = { MAX_ENTRIES, MAX_CHARS } as const;
