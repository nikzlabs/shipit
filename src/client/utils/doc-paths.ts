import type { DocEntry } from "../../server/shared/types.js";

/** Return the directory portion of a path, including trailing slash. Empty string if no slash. */
export function dirOf(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  if (lastSlash < 0) return "";
  return path.slice(0, lastSlash + 1);
}

/** Return the filename (last segment) of a path. */
export function basenameOf(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  return lastSlash < 0 ? path : path.slice(lastSlash + 1);
}

/** Return true for the secondary tracking file in a feature-doc directory. */
export function isChecklistPath(path: string): boolean {
  return basenameOf(path).toLowerCase() === "checklist.md";
}

/**
 * Return all entries in `entries` whose directory matches `path`'s directory.
 * The result includes the entry for `path` itself (if present in `entries`).
 * Order is the same as `entries`.
 */
export function siblingsOf<T extends { path: string }>(path: string, entries: T[]): T[] {
  const dir = dirOf(path);
  return entries.filter((e) => dirOf(e.path) === dir);
}

/** Filename (without extension), lowercased. Used for ordering siblings. */
function stem(path: string): string {
  const name = basenameOf(path);
  const dot = name.lastIndexOf(".");
  return (dot < 0 ? name : name.slice(0, dot)).toLowerCase();
}

/**
 * Order sibling docs for the modal tab strip:
 * `plan` first, `checklist` second, then alphabetical by stem.
 */
export function orderSiblingsForTabs<T extends { path: string }>(siblings: T[]): T[] {
  const rank = (p: string): number => {
    const s = stem(p);
    if (s === "plan") return 0;
    if (s === "checklist") return 1;
    return 2;
  };
  return [...siblings].sort((a, b) => {
    const r = rank(a.path) - rank(b.path);
    if (r !== 0) return r;
    return stem(a.path).localeCompare(stem(b.path));
  });
}

/**
 * Human-readable label for a sibling tab. Capitalizes the filename stem
 * ("plan" → "Plan", "checklist" → "Checklist", "readme" → "Readme").
 */
export function siblingTabLabel(path: string): string {
  const s = stem(path);
  if (!s) return path;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Return true if the doc has any `status:` frontmatter — either one of the
 * known enum values (`status`) or an unrecognized one (`customStatus`).
 * Used to decide whether a doc shows up in the Tracked tab and as a sibling
 * suppressor for unstatused files alongside it.
 *
 * The intent: the author wrote a `status:` line, so they meant to track it,
 * even if the value isn't one we recognize. Compare with the closed enum
 * `DocStatus`, which we keep strict so the UI's status buckets stay typed.
 */
export function isTracked(entry: Pick<DocEntry, "status" | "customStatus">): boolean {
  return entry.status !== undefined || entry.customStatus !== undefined;
}

/**
 * Return true if `entries` contains a tracked doc in the same directory as
 * `path` other than `path` itself. Used to hide standalone checklist.md
 * entries in the Other tab when their plan sibling exists.
 *
 * Files at the repo root (no directory prefix) are never considered siblings —
 * the "feature directory" concept only applies inside a folder like
 * `docs/NNN-feature/`. A top-level `README.md` next to a top-level tracked
 * doc would otherwise be erroneously hidden.
 */
export function hasTrackedSibling(path: string, entries: DocEntry[]): boolean {
  const dir = dirOf(path);
  if (dir === "") return false;
  return entries.some(
    (e) => e.path !== path && isTracked(e) && dirOf(e.path) === dir,
  );
}

/**
 * Return true when `path` is a checklist with a tracked `plan.md` in the same
 * directory. Feature checklists can carry frontmatter for the modal and
 * scanner, but the docs list should still render the tracked plan as the
 * single primary row.
 */
export function hasTrackedPlanSibling(path: string, entries: DocEntry[]): boolean {
  if (!isChecklistPath(path)) return false;
  const dir = dirOf(path);
  if (dir === "") return false;
  return entries.some(
    (e) =>
      e.path !== path &&
      dirOf(e.path) === dir &&
      basenameOf(e.path).toLowerCase() === "plan.md" &&
      isTracked(e),
  );
}
