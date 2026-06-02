/**
 * Doc path ordering: feature docs newest-first.
 *
 * Feature docs live in `docs/NNN-feature/` directories numbered by creation
 * order, so the `NNN` prefix is a reliable proxy for "how new is this doc".
 * Ordering descending by that number floats the newest work to the top of the
 * list, where it's most likely to be wanted — docs/168 removed the explicit
 * priority/status signal, so creation-recency is the best ordering left.
 *
 * A plain `localeCompare` can't express this for two reasons:
 *
 *   1. It's lexical, so `"100"` sorts before `"99"` — wrong at the 99→100
 *      boundary and again past 999. We compare the numeric prefix as a number,
 *      so the order is correct no matter how many digits the corpus grows to.
 *
 *   2. We want descending, but only among the numbered docs. A stray
 *      un-numbered doc (`architecture.md`, a top-level `README.md`) must not
 *      jump above the newest feature just because it sorts high lexically.
 *      Numbered segments always sink un-numbered ones below them, and
 *      un-numbered segments keep a stable *ascending* order among themselves
 *      (descending random prose reads worse than A→Z).
 *
 * The comparison is segment-by-segment over the `/`-split path so the feature
 * directory (`docs/NNN-feature`) drives the order while same-directory siblings
 * (`plan.md`, `checklist.md`) fall into a deterministic tiebreak.
 */

interface ParsedSegment {
  /** Leading integer prefix (`168` from `168-feature`), or null if none. */
  num: number | null;
  /** The full segment text, used for lexical tiebreaks. */
  text: string;
}

/** Split a path segment into its leading numeric prefix (if any) and text. */
function parseSegment(segment: string): ParsedSegment {
  const match = /^(\d+)/.exec(segment);
  if (!match) return { num: null, text: segment };
  // parseInt over the matched digits — Number.MAX_SAFE_INTEGER is 2^53, far
  // beyond any plausible NNN, so precision loss isn't a concern here.
  return { num: Number.parseInt(match[1], 10), text: segment };
}

/**
 * Compare two path segments for newest-first order. Returns a negative number
 * when `a` should sort before `b`, positive when after, zero when equal.
 */
function compareSegment(a: string, b: string): number {
  const pa = parseSegment(a);
  const pb = parseSegment(b);

  if (pa.num !== null && pb.num !== null) {
    // Both numbered: higher number is newer, so it sorts first (descending).
    if (pa.num !== pb.num) return pb.num - pa.num;
    // Same number (e.g. `168-foo` vs `168-bar`): stable ascending tiebreak.
    return a.localeCompare(b);
  }

  // Exactly one numbered: the numbered segment is a real feature and sorts
  // above the un-numbered prose, regardless of letters.
  if (pa.num !== null) return -1;
  if (pb.num !== null) return 1;

  // Neither numbered: plain ascending — A→Z reads better than Z→A for prose.
  return a.localeCompare(b);
}

/**
 * Compare two doc paths for newest-first ordering. Suitable as an
 * `Array.prototype.sort` comparator over path strings.
 */
export function compareDocsByRecency(a: string, b: string): number {
  if (a === b) return 0;
  const aSegs = a.split("/");
  const bSegs = b.split("/");
  const len = Math.min(aSegs.length, bSegs.length);

  for (let i = 0; i < len; i++) {
    const cmp = compareSegment(aSegs[i], bSegs[i]);
    if (cmp !== 0) return cmp;
  }

  // One path is a prefix of the other (e.g. `docs/x` vs `docs/x/plan.md`).
  // Shorter (shallower) path first — it's the parent.
  return aSegs.length - bSegs.length;
}

/**
 * Return a new array of `{ path }` entries ordered newest-first. Does not
 * mutate the input.
 */
export function sortDocsByRecency<T extends { path: string }>(docs: readonly T[]): T[] {
  return [...docs].sort((a, b) => compareDocsByRecency(a.path, b.path));
}
