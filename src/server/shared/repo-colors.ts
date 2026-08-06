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
 * Pick a color for a new repo: the lowest palette index nobody is using yet.
 *
 * Lowest-free rather than round-robin so the early colors stay stable as repos
 * come and go — removing repo #2 and adding another gives the new one #2's old
 * slot rather than shifting everyone. Once every index is taken (17+ repos) it
 * wraps to the least-used index, which is the first repeat req 5 allows.
 */
export function pickRepoColorIndex(taken: readonly number[]): number {
  const counts = new Array<number>(REPO_COLOR_COUNT).fill(0);
  for (const idx of taken) {
    if (isValidRepoColorIndex(idx)) counts[idx] += 1;
  }
  let best = 0;
  for (let i = 1; i < REPO_COLOR_COUNT; i++) {
    if (counts[i] < counts[best]) best = i;
  }
  return best;
}

/** The CSS custom property backing a palette index. */
export function repoColorVar(index: number): string {
  return `var(--repo-color-${isValidRepoColorIndex(index) ? index : 0})`;
}
