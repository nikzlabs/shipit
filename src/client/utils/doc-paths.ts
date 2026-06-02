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
 * Return true if `path` is a feature-directory `plan.md`. The primary row of a
 * feature directory is always tracked, regardless of frontmatter.
 */
export function isPlanPath(path: string): boolean {
  return basenameOf(path).toLowerCase() === "plan.md";
}

/**
 * Return true when a doc is "tracked" — i.e. a primary work doc that belongs in
 * the Tracked list, as opposed to incidental markdown (a stray `README.md`,
 * `notes.md`, etc.).
 *
 * docs/168 removed `status`/`priority` frontmatter, so tracking can no longer
 * key off a `status:` line. The replacement is purely structural and needs no
 * frontmatter: a doc is tracked if it is a feature-directory `plan.md` or
 * `checklist.md`, carries an `issue:` pointer, or has a `checklist.md` sibling
 * in the same directory. This keeps the same docs "tracked" as before (every
 * feature dir has a plan and/or checklist) without depending on the removed
 * fields.
 */
export function isTracked(
  entry: Pick<DocEntry, "path" | "issue">,
  entries: DocEntry[],
): boolean {
  if (isPlanPath(entry.path)) return true;
  if (isChecklistPath(entry.path)) return true;
  if (entry.issue !== undefined) return true;
  const dir = dirOf(entry.path);
  if (dir === "") return false;
  return entries.some(
    (e) =>
      e.path !== entry.path &&
      dirOf(e.path) === dir &&
      isChecklistPath(e.path),
  );
}

/**
 * Return true if `entries` contains a tracked doc in the same directory as
 * `path` other than `path` itself. Used to hide incidental files (e.g. a stray
 * `README.md`) in the Other tab when a tracked doc exists alongside them.
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
    (e) => e.path !== path && isTracked(e, entries) && dirOf(e.path) === dir,
  );
}

/**
 * Return true when `path` is a checklist with a `plan.md` in the same
 * directory. A feature directory renders its `plan.md` as the single primary
 * row, so the sibling checklist is suppressed from the list (it stays
 * reachable via the modal's sibling tabs). Structural test — needs no
 * frontmatter.
 */
export function hasTrackedPlanSibling(path: string, entries: DocEntry[]): boolean {
  if (!isChecklistPath(path)) return false;
  const dir = dirOf(path);
  if (dir === "") return false;
  return entries.some(
    (e) => e.path !== path && dirOf(e.path) === dir && isPlanPath(e.path),
  );
}
