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
 * Return true if `entries` contains a tracked doc (status set) in the same
 * directory as `path` other than `path` itself. Used to hide standalone
 * checklist.md entries in the Other tab when their plan sibling exists.
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
    (e) => e.path !== path && e.status !== undefined && dirOf(e.path) === dir,
  );
}
