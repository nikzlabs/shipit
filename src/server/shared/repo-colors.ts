/** Indices match --repo-color-N in client/index.css. Store indices, not hex values. */
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

export const REPO_COLOR_COUNT = REPO_COLOR_NAMES.length;

export function isValidRepoColorIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < REPO_COLOR_COUNT;
}

// Farthest-point order across both themes; regenerate with repo-palette.test.ts.
export const REPO_COLOR_ASSIGNMENT_ORDER = [
  6, 12, 3, 9, 1, 4, 10, 5, 15, 8, 11, 2, 14, 0, 13, 7,
] as const;

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

export function repoColorVar(index: number): string {
  return `var(--repo-color-${isValidRepoColorIndex(index) ? index : 0})`;
}
