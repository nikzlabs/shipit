/**
 * docs/254 — the repo-identity palette backing the sidebar's per-repo edge.
 *
 * Shared by both layers on purpose: the orchestrator needs the size to assign a
 * color at add time and to validate a user's pick, and the client needs the
 * names for the picker's labels and tooltips. The actual COLORS are not here —
 * they're `--repo-color-0` … `--repo-color-15` in `client/index.css`, with a
 * light value and a dark override, so a stored index re-maps per theme instead
 * of pinning one hex that can only look right on half the themes (req 12).
 *
 * Store the INDEX, never the hex. Changing a palette entry then restyles every
 * repo that uses it, and a theme can disagree about what "indigo" looks like.
 */

/** Human-readable names, index-aligned with `--repo-color-N`. */
export const REPO_COLOR_NAMES = [
  "Clay",
  "Ochre",
  "Mustard",
  "Olive",
  "Fern",
  "Pine",
  "Cyan",
  "Steel",
  "Denim",
  "Lavender",
  "Orchid",
  "Rose",
  "Brick",
  "Sienna",
  "Slate",
  "Taupe",
] as const;

/**
 * Palette size. Sixteen is the answer to "big enough" (req 8): it comfortably
 * exceeds the repo count of every real workspace we've seen, so the
 * skip-what's-taken assignment below effectively never wraps.
 */
export const REPO_COLOR_COUNT = REPO_COLOR_NAMES.length;

/** True when `value` is a usable palette index. */
export function isValidRepoColorIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < REPO_COLOR_COUNT;
}

/**
 * The order colors are handed out in — NOT palette order.
 *
 * The palette is laid out as a hue wheel (Clay → Ochre → Mustard → Olive → …),
 * which is what the picker grid wants but the worst possible thing to assign
 * from in sequence: a workspace with three repos got three adjacent warm
 * ochres, and the whole point of req 5 is that the groups read as different at
 * a glance. So assignment walks this order instead.
 *
 * It is a farthest-point traversal: each entry is the one whose closest
 * approach to ANY already-assigned color is largest, measured as the worse of
 * its light and dark values (a pair can be distinct on one surface and not the
 * other). Distance to the nearest earlier pick goes 268 → 161 → 121 → 95 for
 * the first four repos, against 68 → 53 → 58 walking the palette in order.
 *
 * Regenerate rather than hand-edit if the palette changes: `repo-palette.test.ts`
 * carries both the metric and the check that this order stays the spread one.
 */
export const REPO_COLOR_ASSIGNMENT_ORDER = [
  6, 12, 3, 9, 1, 4, 10, 5, 15, 8, 11, 2, 14, 0, 13, 7,
] as const;

/**
 * Pick a color for a new repo: the first color in assignment order that nobody
 * is using yet.
 *
 * First-free rather than round-robin so the early colors stay stable as repos
 * come and go — removing the second repo and adding another gives the new one
 * that freed slot rather than shifting everyone. Once every index is taken
 * (17+ repos) it wraps to the least-used index, which is the first repeat req 5
 * allows; ties there break by assignment order, so the repeats spread out too.
 */
export function pickRepoColorIndex(taken: readonly number[]): number {
  const counts = new Array<number>(REPO_COLOR_COUNT).fill(0);
  for (const idx of taken) {
    if (isValidRepoColorIndex(idx)) counts[idx] += 1;
  }
  let best: number = REPO_COLOR_ASSIGNMENT_ORDER[0];
  for (const i of REPO_COLOR_ASSIGNMENT_ORDER) {
    if (counts[i] === 0) return i;
    if (counts[i] < counts[best]) best = i;
  }
  return best;
}

/** The CSS custom property backing a palette index. */
export function repoColorVar(index: number): string {
  return `var(--repo-color-${isValidRepoColorIndex(index) ? index : 0})`;
}
